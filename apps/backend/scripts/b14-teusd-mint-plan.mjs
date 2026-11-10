/**
 * B14 B5-A: canonical exact TEUSD mint intent for a committed B12 match.
 * PREVIEW is read-only. --stage persists PLANNED only. No private keys,
 * signing, minting, broadcasting, approvals or HBAR transfers in this file.
 */
import { Interface } from 'ethers';
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import {
  parseMintArgs, requireMintStagePermission, requireConfirmedBuyerHbar,
  confirmBuyerHbarOnChain, disallowPrematureOperations, prepareMintIntent,
  existingMintDisposition, displayTeusd,
} from './b14-teusd-mint-core.mjs';

async function main() {
  const args=parseMintArgs(process.argv.slice(2));
  const stage=requireMintStagePermission(args,process.env);
  if (process.env.HEDERA_NETWORK!=='testnet' || !process.env.HEDERA_TESTNET_RPC_URL || !process.env.DATABASE_URL) {
    throw new Error('Requires Hedera Testnet RPC, HEDERA_NETWORK=testnet, and DATABASE_URL');
  }
  const artifacts=loadVerifiedContractArtifacts();
  const [{PrismaPg},{PrismaClient}]=await Promise.all([
    import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js'),
  ]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try {
    const match=await prisma.match.findUnique({where:{id:args.matchId}});
    if (!match) throw new Error('B12 selected match not found');
    const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
    if (!run) throw new Error('B12 matching run missing');
    const [matches,energies,buyerWallet,sellerWallet,buyerProfile,localTrade,journals]=await Promise.all([
      prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
      prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
      prisma.wallet.findUnique({where:{userId:match.buyerId}}),
      prisma.wallet.findUnique({where:{userId:match.sellerId}}),
      prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
      prisma.trade.findUnique({where:{matchId:match.id}}),
      prisma.b14TransactionIntent.findMany({where:{matchId:match.id}}),
    ]);
    const terms=assertStoredMatch({match,run,rows:matches,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
    if (!buyerWallet?.hederaAccountId) throw new Error('Buyer must have a verified B07 Hedera account');
    disallowPrematureOperations(journals);
    const hbarJournal=journals.find(j=>j.operation==='FUND_BUYER_HBAR');
    const mintJournal=journals.find(j=>j.operation==='MINT_TEUSD');
    const extId=externalTradeId(match.id,artifacts.EnergyTradingEscrow.address);
    if (!hbarJournal) throw new Error('Confirmed buyer HBAR journal required before minting');
    const fundedBy=hbarJournal.signerAddress;
    requireConfirmedBuyerHbar(hbarJournal,{matchId:match.id,externalTradeId:extId,operatorAddress:fundedBy,buyerAddress:terms.buyer});

    const deployment=await reader.verifyDeployment();
    if (deployment.chainId!==296 || deployment.escrowPaused) throw new Error('Escrow paused or wrong Hedera chain');
    const {provider,token}=await reader.getConnection();
    const role=await token.MINTER_ROLE();
    const [minter,decimals,symbol,buyerTokenUnits,buyerHbarWei,adminHbarWei,chainTradeId,receipt,fundingTx]=await Promise.all([
      token.hasRole(role,args.adminAddress),token.decimals(),token.symbol(),
      token.balanceOf(terms.buyer),provider.getBalance(terms.buyer),provider.getBalance(args.adminAddress),
      reader.getOnChainTradeId(extId),provider.getTransactionReceipt(hbarJournal.txHash),
      provider.getTransaction(hbarJournal.txHash),
    ]);
    confirmBuyerHbarOnChain(receipt,fundingTx,hbarJournal,{buyerAddress:terms.buyer,operatorAddress:fundedBy});
    const plan=prepareMintIntent({matchId:match.id,externalTradeId:extId,adminAddress:args.adminAddress,
      tokenAddress:artifacts.TestEnergyUSD.address,buyerAddress:terms.buyer,
      amountMicrousd:terms.totalAmountMicrousd,buyerTeusdUnits:buyerTokenUnits.toString(),
      buyerHbarWei:buyerHbarWei.toString(),adminHbarWei:adminHbarWei.toString(),
      adminHasMinterRole:minter,tokenDecimals:Number(decimals),tokenSymbol:symbol,
      chainId:deployment.chainId,matchStatus:match.status,escrowPaused:deployment.escrowPaused,
      existingLocalTrade:localTrade,existingOnChainId:chainTradeId,
    });
    const tokenInterface=new Interface(artifacts.TestEnergyUSD.abi);
    const abiMint=tokenInterface.encodeFunctionData('mint',[terms.buyer,BigInt(terms.totalAmountMicrousd)]);
    if (plan.callData!==abiMint.toLowerCase()) throw new Error('Canonical TEUSD mint calldata differs from trusted ABI');
    const disposition=existingMintDisposition(mintJournal,plan);
    console.log('B14 B5 MINT PLAN: '+JSON.stringify({
      matchId:match.id,chainId:296,operation:plan.operation,adminAddress:plan.signerAddress,
      buyerAddress:terms.buyer,tokenAddress:plan.targetAddress,
      tokenSymbol:symbol,tokenDecimals:Number(decimals),mintUnits:terms.totalAmountMicrousd,
      mintTeusd:displayTeusd(terms.totalAmountMicrousd),buyerHbarWei:buyerHbarWei.toString(),
      buyerTeusdUnits:buyerTokenUnits.toString(),fundingHbarTxHash:hbarJournal.txHash,
      hbarJournalStatus:hbarJournal.status,adminHasMinterRole:minter,existingOnChainTradeId:chainTradeId,
      calldataSelector:plan.callData.slice(0,10),valueWei:plan.valueWei,
      externalTradeId:plan.externalTradeId,payloadSha256:plan.payloadSha256,
      journal:disposition,databaseWriteRequested:stage,
    },null,2));
    if (!stage) {
      console.log('B14 B5 PREVIEW PASS: confirmed HBAR funding and exact B12 token amount; no DB writes, signatures, minting, approvals or broadcast');
      return;
    }
    const outcome=await prisma.$transaction(async(tx)=>{
      // Avoid concurrent stages on this B12 match; protect the confirmed HBAR journal.
      const locked=await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
      if (!Array.isArray(locked)||locked.length!==1) throw new Error('Selected B12 match disappeared');
      const lockedMatch=await tx.match.findUnique({where:{id:match.id},select:{status:true}});
      if (lockedMatch?.status!=='SELECTED') throw new Error('Match status changed before mint staging');
      const currentJournals=await tx.b14TransactionIntent.findMany({where:{matchId:match.id}});
      disallowPrematureOperations(currentJournals);
      const currentHbar=currentJournals.find(j=>j.operation==='FUND_BUYER_HBAR');
      requireConfirmedBuyerHbar(currentHbar,{matchId:match.id,externalTradeId:extId,
        operatorAddress:fundedBy,buyerAddress:terms.buyer});
      const prior=currentJournals.find(j=>j.operation==='MINT_TEUSD');
      if (prior) {
        existingMintDisposition(prior,plan);
        return {kind:'UNCHANGED',row:prior};
      }
      // Recheck the crucial off-chain mutable token balance and role before staging.
      const [freshBuyerBalance,freshRole,freshTradeId]=await Promise.all([
        token.balanceOf(terms.buyer),token.hasRole(role,args.adminAddress),reader.getOnChainTradeId(extId),
      ]);
      if (freshBuyerBalance!==0n || !freshRole || freshTradeId!=='0') {
        throw new Error('Buyer token balance, minter role, or on-chain trade changed: stop');
      }
      const row=await tx.b14TransactionIntent.create({data:{
        matchId:match.id,externalTradeId:extId,operation:'MINT_TEUSD',chainId:296,
        signerAddress:plan.signerAddress,targetAddress:plan.targetAddress,
        payloadSha256:plan.payloadSha256,status:'PLANNED',
      }});
      return {kind:'CREATED',row};
    },{timeout:45_000,maxWait:10_000});
    console.log(`B14 B5 STAGED: ${outcome.kind} intent=${outcome.row.id} operation=MINT_TEUSD status=${outcome.row.status}`);
    console.log('B14 B5 SAFE: PostgreSQL intent only; NO mint signed or submitted, no token balance changes');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}
main().catch(error=>{
  console.error('B14 B5 FAILED:',error instanceof Error?error.message:String(error));
  console.error('STOP: do not mint manually, reset or replace an existing intent to bypass a conflict');
  process.exitCode=1;
});
