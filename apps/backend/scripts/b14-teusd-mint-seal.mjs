/**
 * B14 B5-B: read-only TEUSD mint sealing PREVIEW, or explicitly approved encrypted
 * local signing of the EXACT pre-staged MINT_TEUSD journal row.
 * NEVER broadcasts, mints on-chain, transfers HBAR, or creates new intents.
 */
import { Wallet, Transaction, Interface } from 'ethers';
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import { encryptSignedTransaction, checkTransition } from './b14-intent-journal-core.mjs';
import {
  requireConfirmedBuyerHbar, confirmBuyerHbarOnChain, disallowPrematureOperations,
  prepareMintIntent, displayTeusd,
} from './b14-teusd-mint-core.mjs';
import {
  parseMintSealArgs, requireMintSealPermission, verifyPlannedMintJournal,
  requireCleanMintSignerQueue, requireMintNonce, safeMintGasQuote,
  makeUnsignedMint, verifySignedMintEnvelope,
} from './b14-teusd-mint-seal-core.mjs';

async function main() {
  const args=parseMintSealArgs(process.argv.slice(2));
  const sealing=requireMintSealPermission(args,process.env);
  if (process.env.HEDERA_NETWORK!=='testnet' || !process.env.HEDERA_TESTNET_RPC_URL || !process.env.DATABASE_URL) {
    throw new Error('HEDERA_NETWORK=testnet, HEDERA_TESTNET_RPC_URL and DATABASE_URL required');
  }
  if (!process.env.HEDERA_ADMIN_PRIVATE_KEY) throw new Error('HEDERA_ADMIN_PRIVATE_KEY missing: load ignored contracts/.env');
  if (sealing && !process.env.B14_SIGNED_TX_KEY_B64) {
    throw new Error('B14_SIGNED_TX_KEY_B64 missing: cannot persist an unencrypted signed transaction');
  }
  const admin=new Wallet(process.env.HEDERA_ADMIN_PRIVATE_KEY);
  if (admin.address.toLowerCase()!==args.adminAddress) {
    throw new Error('Locally configured admin signing key DOES NOT match chosen public minter address');
  }

  const artifacts=loadVerifiedContractArtifacts();
  const [{PrismaPg},{PrismaClient}]=await Promise.all([
    import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js'),
  ]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try {
    const match=await prisma.match.findUnique({where:{id:args.matchId}});
    if (!match) throw new Error('Selected B12 match not found');
    const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
    if (!run) throw new Error('B12 matching run missing');
    const [rows,energies,buyerWallet,sellerWallet,buyerProfile,localTrade,journals]=await Promise.all([
      prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
      prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
      prisma.wallet.findUnique({where:{userId:match.buyerId}}),
      prisma.wallet.findUnique({where:{userId:match.sellerId}}),
      prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
      prisma.trade.findUnique({where:{matchId:match.id}}),
      prisma.b14TransactionIntent.findMany({where:{matchId:match.id}}),
    ]);
    const terms=assertStoredMatch({match,run,rows,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
    if (!buyerWallet?.hederaAccountId) throw new Error('B07 buyer Hedera account not verified');
    disallowPrematureOperations(journals);
    const extId=externalTradeId(match.id,artifacts.EnergyTradingEscrow.address);
    const hbarJournal=journals.find(row=>row.operation==='FUND_BUYER_HBAR');
    const mintJournal=journals.find(row=>row.operation==='MINT_TEUSD');
    if (!hbarJournal) throw new Error('Missing previously confirmed buyer HBAR journal');
    requireConfirmedBuyerHbar(hbarJournal,{
      matchId:match.id,externalTradeId:extId,operatorAddress:hbarJournal.signerAddress,buyerAddress:terms.buyer,
    });

    const deployment=await reader.verifyDeployment();
    if (deployment.chainId!==296 || deployment.escrowPaused) throw new Error('Wrong chain or paused escrow');
    const {provider,token}=await reader.getConnection();
    const minterRole=await token.MINTER_ROLE();
    const [hasRole,buyerTeusd,buyerHbar,adminHbar,chainTradeId,receipt,fundingTx]=await Promise.all([
      token.hasRole(minterRole,args.adminAddress),token.balanceOf(terms.buyer),
      provider.getBalance(terms.buyer),provider.getBalance(args.adminAddress),
      reader.getOnChainTradeId(extId),provider.getTransactionReceipt(hbarJournal.txHash),
      provider.getTransaction(hbarJournal.txHash),
    ]);
    confirmBuyerHbarOnChain(receipt,fundingTx,hbarJournal,{
      buyerAddress:terms.buyer,operatorAddress:hbarJournal.signerAddress,
    });
    const plan=prepareMintIntent({
      matchId:match.id,externalTradeId:extId,adminAddress:args.adminAddress,
      tokenAddress:artifacts.TestEnergyUSD.address,buyerAddress:terms.buyer,
      amountMicrousd:terms.totalAmountMicrousd,buyerTeusdUnits:buyerTeusd.toString(),
      buyerHbarWei:buyerHbar.toString(),adminHbarWei:adminHbar.toString(),
      adminHasMinterRole:hasRole,tokenDecimals:deployment.tokenDecimals,
      tokenSymbol:deployment.tokenSymbol,chainId:deployment.chainId,
      matchStatus:match.status,escrowPaused:deployment.escrowPaused,
      existingLocalTrade:localTrade,existingOnChainId:chainTradeId,
    });
    const tokenInterface=new Interface(artifacts.TestEnergyUSD.abi);
    const abiCalldata=tokenInterface.encodeFunctionData('mint',[terms.buyer,BigInt(terms.totalAmountMicrousd)]);
    if (plan.callData!==abiCalldata.toLowerCase()) throw new Error('Trusted TEUSD ABI disagrees with mint journal call data');
    verifyPlannedMintJournal(mintJournal,plan,args.intentId);
    const otherActive=await prisma.b14TransactionIntent.findMany({
      where:{signerAddress:args.adminAddress,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']}},
      select:{id:true,status:true},
    });
    requireCleanMintSignerQueue(otherActive,args.intentId);

    async function quoteMint() {
      const [latest,pending,estimatedGas,feeData,balance]=await Promise.all([
        provider.getTransactionCount(args.adminAddress,'latest'),
        provider.getTransactionCount(args.adminAddress,'pending'),
        provider.estimateGas({from:args.adminAddress,to:plan.targetAddress,data:plan.callData,value:0n}),
        provider.getFeeData(),provider.getBalance(args.adminAddress),
      ]);
      const nonce=requireMintNonce(latest,pending);
      if (!feeData.gasPrice) throw new Error('Hedera RPC did not provide legacy gasPrice');
      const fees=safeMintGasQuote({estimatedGas,gasPriceWei:feeData.gasPrice,adminBalanceWei:balance});
      const unsigned=makeUnsignedMint({chainId:296,adminAddress:args.adminAddress,
        tokenAddress:plan.targetAddress,buyerAddress:terms.buyer,
        amountUnits:terms.totalAmountMicrousd,callData:plan.callData,nonce,
        gasLimit:fees.gasLimit,gasPriceWei:fees.gasPriceWei});
      return {nonce,estimatedGas:BigInt(estimatedGas),fees,unsigned};
    }

    const preview=await quoteMint();
    console.log('B14 B5-B PREVIEW: '+JSON.stringify({
      chainId:296,matchId:match.id,intentId:mintJournal.id,operation:'MINT_TEUSD',
      journalStatus:mintJournal.status,adminAddress:args.adminAddress,
      buyerAddress:terms.buyer,tokenAddress:plan.targetAddress,
      mintUnits:terms.totalAmountMicrousd,mintTeusd:displayTeusd(terms.totalAmountMicrousd),
      calldataSelector:plan.callData.slice(0,10),payloadSha256:plan.payloadSha256,
      buyerHbarWei:buyerHbar.toString(),buyerTeusdUnits:buyerTeusd.toString(),
      adminHasMinterRole:hasRole,existingOnChainTradeId:chainTradeId,
      adminNonce:String(preview.nonce),estimatedGas:preview.estimatedGas.toString(),
      gasLimit:preview.fees.gasLimit.toString(),rpcGasPriceWei:preview.fees.gasPriceWei.toString(),
      maxGasFeeWei:preview.fees.maxFeeWei.toString(),
      action:sealing?'SEAL_ENCRYPTED_MINT_ONLY':'PREVIEW_ONLY',
    },null,2));
    if (!sealing) {
      console.log('B14 B5-B PREVIEW PASS: no mint signing, database mutations, token minting, contract calls that write, or broadcast');
      return;
    }

    // A signer-scoped PostgreSQL advisory lock plus a FOR UPDATE journal row lock.
    // External admin-wallet software is NOT coordinated by this lock; the nonce guards are mandatory.
    const saved=await prisma.$transaction(async(tx)=>{
      await tx.$queryRaw`SELECT 1::int AS acquired FROM pg_advisory_xact_lock(296,hashtext(${args.adminAddress}))`;
      const locked=await tx.$queryRaw`SELECT "id" FROM "b14_transaction_intents" WHERE "id" = ${args.intentId}::uuid FOR UPDATE`;
      if (!Array.isArray(locked)||locked.length!==1) throw new Error('Mint journal row disappeared');
      const fresh=await tx.b14TransactionIntent.findUnique({where:{id:args.intentId}});
      verifyPlannedMintJournal(fresh,plan,args.intentId);
      const matchState=await tx.match.findUnique({where:{id:match.id},select:{status:true}});
      if (matchState?.status!=='SELECTED') throw new Error('Selected match changed during mint signing');
      const currentJournals=await tx.b14TransactionIntent.findMany({where:{matchId:match.id}});
      disallowPrematureOperations(currentJournals);
      const currentHbar=currentJournals.find(row=>row.operation==='FUND_BUYER_HBAR');
      requireConfirmedBuyerHbar(currentHbar,{
        matchId:match.id,externalTradeId:extId,operatorAddress:hbarJournal.signerAddress,buyerAddress:terms.buyer,
      });
      const queue=await tx.b14TransactionIntent.findMany({
        where:{signerAddress:args.adminAddress,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']}},
        select:{id:true,status:true},
      });
      requireCleanMintSignerQueue(queue,args.intentId);
      const [freshTokenBalance,freshBuyerHbar,freshRole,freshTradeId,freshDeployment,freshLocalTrade]=await Promise.all([
        token.balanceOf(terms.buyer),provider.getBalance(terms.buyer),
        token.hasRole(minterRole,args.adminAddress),reader.getOnChainTradeId(extId),
        reader.verifyDeployment(),tx.trade.findUnique({where:{matchId:match.id}}),
      ]);
      if (freshTokenBalance!==0n || freshBuyerHbar < 100_000_000_000_000_000n || !freshRole ||
          freshTradeId!=='0' || freshDeployment.escrowPaused || freshLocalTrade) {
        throw new Error('Buyer funding or trade/minter contract state changed during mint signing');
      }
      // Re-check that the previously confirmed funding receipt remains available.
      const [freshFundingReceipt,freshFundingTx]=await Promise.all([
        provider.getTransactionReceipt(currentHbar.txHash),provider.getTransaction(currentHbar.txHash),
      ]);
      confirmBuyerHbarOnChain(freshFundingReceipt,freshFundingTx,currentHbar,{
        buyerAddress:terms.buyer,operatorAddress:hbarJournal.signerAddress,
      });
      const freshQuote=await quoteMint();
      if (freshQuote.nonce!==preview.nonce) throw new Error('Admin nonce changed since mint preview; stop');
      const raw=await admin.signTransaction(freshQuote.unsigned); // LOCAL ONLY, no RPC write
      const signed=Transaction.from(raw);
      const hash=verifySignedMintEnvelope(signed,freshQuote.unsigned,args.adminAddress);
      const encrypted=encryptSignedTransaction(raw,process.env.B14_SIGNED_TX_KEY_B64,fresh.id);
      checkTransition('PLANNED','SIGNED');
      return tx.b14TransactionIntent.update({where:{id:fresh.id},data:{
        status:'SIGNED',nonce:String(freshQuote.nonce),txHash:hash,
        signedTxCiphertext:encrypted.ciphertext,signedTxIv:encrypted.iv,signedTxTag:encrypted.tag,
      },select:{id:true,status:true,operation:true,txHash:true,nonce:true}});
    },{timeout:45_000,maxWait:10_000});
    console.log(`B14 B5-B SEALED: intent=${saved.id} operation=${saved.operation} status=${saved.status} nonce=${saved.nonce} txHash=${saved.txHash}`);
    console.log('B14 B5-B SAFE: encrypted signed mint persisted; NO token mint, broadcast, HBAR transfer, approval, or escrow transaction');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}
main().catch(error=>{
  console.error('B14 B5-B FAILED:',error instanceof Error?error.message:String(error));
  console.error('STOP: inspect journal status before retrying; never reset an intent or sign a replacement to bypass a conflict');
  process.exitCode=1;
});
