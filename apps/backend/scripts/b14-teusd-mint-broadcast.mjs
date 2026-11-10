/**
 * B14 Phase B5-C: broadcast ONCE the existing, encrypted, already-signed TEUSD
 * mint (250232 units). Default PREVIEW is read-only. No private key loaded,
 * no replacement transaction, no new intent or automatic rebroadcast.
 */
import { Transaction } from 'ethers';
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { requireConfirmedBuyerHbar, confirmBuyerHbarOnChain, displayTeusd } from './b14-teusd-mint-core.mjs';
import {
  parseMintBroadcastArgs, requireMintBroadcastPermission, canonicalMintPlan,
  verifyStoredMint, decodeVerifiedMint, observedMintState, requireMintEffect,
  requireMintSubmitAllowed, assertMintRelayHash, decideMintReconciliation, sanitizeMintRpcError,
} from './b14-teusd-mint-broadcast-core.mjs';

async function main(){
  const args=parseMintBroadcastArgs(process.argv.slice(2));
  requireMintBroadcastPermission(args,process.env);
  if(process.env.HEDERA_NETWORK!=='testnet'||!process.env.HEDERA_TESTNET_RPC_URL||
    !process.env.DATABASE_URL||!process.env.B14_SIGNED_TX_KEY_B64){
    throw new Error('Hedera Testnet RPC, DATABASE_URL and existing B14 encryption key required');
  }
  const artifacts=loadVerifiedContractArtifacts();
  const [{PrismaPg},{PrismaClient}]=await Promise.all([
    import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js'),
  ]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try {
    const [match,mintJournal]=await Promise.all([
      prisma.match.findUnique({where:{id:args.matchId}}),
      prisma.b14TransactionIntent.findUnique({where:{id:args.intentId}}),
    ]);
    if(!match)throw new Error('B12 match missing');
    const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
    if(!run)throw new Error('B12 matching run missing');
    const [rows,energies,buyerWallet,sellerWallet,buyerProfile,hbarJournal]=await Promise.all([
      prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
      prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
      prisma.wallet.findUnique({where:{userId:match.buyerId}}),
      prisma.wallet.findUnique({where:{userId:match.sellerId}}),
      prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
      prisma.b14TransactionIntent.findUnique({where:{matchId_operation:{matchId:match.id,operation:'FUND_BUYER_HBAR'}}}),
    ]);
    const terms=assertStoredMatch({match,run,rows,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
    if(!buyerWallet?.hederaAccountId)throw new Error('Matched buyer Hedera account not verified');
    const extId=externalTradeId(match.id,artifacts.EnergyTradingEscrow.address);
    const plan=canonicalMintPlan({matchId:match.id,externalTradeId:extId,
      adminAddress:args.adminAddress,tokenAddress:artifacts.TestEnergyUSD.address,
      buyerAddress:terms.buyer,amountUnits:terms.totalAmountMicrousd});
    verifyStoredMint(mintJournal,plan,args.intentId);
    const signed=decodeVerifiedMint(mintJournal,process.env.B14_SIGNED_TX_KEY_B64,plan,
      terms.buyer,terms.totalAmountMicrousd,Transaction.from);
    requireConfirmedBuyerHbar(hbarJournal,{matchId:match.id,externalTradeId:extId,
      operatorAddress:hbarJournal?.signerAddress,buyerAddress:terms.buyer});
    const deployment=await reader.verifyDeployment();
    if(deployment.chainId!==296 || deployment.tokenDecimals!==6 || deployment.tokenSymbol!=='TEUSD'){
      throw new Error('Wrong chain or canonical TEUSD deployment changed');
    }
    const {provider,token,interfaces}=await reader.getConnection();
    const minterRole=await token.MINTER_ROLE();

    async function observe(){
      const [receipt,networkTx,latest,pending,buyerTeusdUnits,buyerHbarWei,adminHbarWei,hasMinterRole,tradeId,localTrade]=await Promise.all([
        provider.getTransactionReceipt(signed.hash),provider.getTransaction(signed.hash),
        provider.getTransactionCount(args.adminAddress,'latest'),
        provider.getTransactionCount(args.adminAddress,'pending'),
        token.balanceOf(terms.buyer),provider.getBalance(terms.buyer),provider.getBalance(args.adminAddress),
        token.hasRole(minterRole,args.adminAddress),reader.getOnChainTradeId(extId),
        prisma.trade.findUnique({where:{matchId:match.id}}),
      ]);
      const state=observedMintState({receipt,networkTx,nonceLatest:latest,noncePending:pending},signed);
      if(state==='CONFIRMED') {
        const events=parseKnownReceiptLogs(receipt,artifacts,interfaces).map(event=>({
          ...event,address:event.contract==='TestEnergyUSD'?artifacts.TestEnergyUSD.address:null,
        }));
        requireMintEffect({events,buyerBalanceUnits:buyerTeusdUnits.toString(),
          tokenAddress:artifacts.TestEnergyUSD.address,buyerAddress:terms.buyer,
          amountUnits:terms.totalAmountMicrousd});
      }
      return {state,receipt,latest,pending,buyerTeusdUnits,buyerHbarWei,adminHbarWei,hasMinterRole,tradeId,localTrade};
    }
    const first=await observe();
    console.log('B14 B5-C CHECK: '+JSON.stringify({chainId:296,matchId:match.id,intentId:mintJournal.id,
      operation:'MINT_TEUSD',journalStatus:mintJournal.status,txHash:signed.hash,
      admin:plan.signerAddress,buyer:terms.buyer,token:plan.targetAddress,
      mintUnits:terms.totalAmountMicrousd,mintTeusd:displayTeusd(terms.totalAmountMicrousd),
      storedNonce:String(signed.nonce),chainLatestNonce:String(first.latest),
      chainPendingNonce:String(first.pending),maxGasFeeWei:signed.maxFeeWei.toString(),
      buyerTeusdUnits:first.buyerTeusdUnits.toString(),chainState:first.state,action:args.action,
    },null,2));
    if(args.action==='PREVIEW'){
      console.log('B14 B5-C PREVIEW PASS: no signatures, DB mutations, token mint, or blockchain broadcast');
      return;
    }

    // Same admin-scoped DB advisory lock and row-level lock as B5-B sealing.
    async function withLockedJournal(fn){
      return prisma.$transaction(async tx=>{
        await tx.$queryRaw`SELECT 1::int AS acquired FROM pg_advisory_xact_lock(296,hashtext(${args.adminAddress}))`;
        const locked=await tx.$queryRaw`SELECT "id" FROM "b14_transaction_intents" WHERE "id"=${args.intentId}::uuid FOR UPDATE`;
        if(!Array.isArray(locked)||locked.length!==1)throw new Error('Signed mint row disappeared');
        const current=await tx.b14TransactionIntent.findUnique({where:{id:args.intentId}});
        verifyStoredMint(current,plan,args.intentId);
        if(current.txHash.toLowerCase()!==signed.hash)throw new Error('Stored mint hash changed under lock');
        return fn(tx,current);
      },{timeout:45_000,maxWait:10_000});
    }
    if(args.action==='RECONCILE'){
      const result=await withLockedJournal(async(tx,current)=>{
        const fresh=await observe();
        const next=decideMintReconciliation(current,fresh.state);
        if(!next)return {from:current.status,to:current.status,chainState:fresh.state,changed:false,buyerTeusdUnits:fresh.buyerTeusdUnits.toString()};
        const data={status:next,lastError:null};
        if(next==='CONFIRMED')data.confirmedAt=new Date();
        if(next==='NEEDS_RECONCILIATION')data.lastError='Signed mint not visible through RPC; never automatically rebroadcast';
        await tx.b14TransactionIntent.update({where:{id:current.id},data});
        return {from:current.status,to:next,chainState:fresh.state,changed:true,buyerTeusdUnits:fresh.buyerTeusdUnits.toString()};
      });
      console.log('B14 B5-C RECONCILED: '+JSON.stringify({...result,txHash:signed.hash,intentId:args.intentId}));
      console.log('B14 B5-C RECONCILE SAFE: no new signature or broadcast');
      return;
    }

    // Claim SUBMITTED durably BEFORE the one external eth_sendRawTransaction call.
    await withLockedJournal(async(tx,current)=>{
      const fresh=await observe();
      const [fundingReceipt,fundingTx,lockedHbar,matchState,stillLocalTrade,otherActive]=await Promise.all([
        provider.getTransactionReceipt(hbarJournal.txHash),provider.getTransaction(hbarJournal.txHash),
        tx.b14TransactionIntent.findUnique({where:{id:hbarJournal.id}}),
        tx.match.findUnique({where:{id:match.id},select:{status:true}}),
        tx.trade.findUnique({where:{matchId:match.id}}),
        tx.b14TransactionIntent.findMany({where:{signerAddress:args.adminAddress,
          status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']},id:{not:args.intentId}},select:{id:true}}),
      ]);
      requireConfirmedBuyerHbar(lockedHbar,{matchId:match.id,externalTradeId:extId,
        operatorAddress:hbarJournal.signerAddress,buyerAddress:terms.buyer});
      confirmBuyerHbarOnChain(fundingReceipt,fundingTx,lockedHbar,{
        buyerAddress:terms.buyer,operatorAddress:hbarJournal.signerAddress});
      if(fresh.buyerHbarWei<100_000_000_000_000_000n)throw new Error('Buyer no longer has minimum 0.1 HBAR');
      requireMintSubmitAllowed({row:current,state:fresh.state,adminBalanceWei:fresh.adminHbarWei,
        buyerBalanceUnits:fresh.buyerTeusdUnits,signed,hasMinterRole:fresh.hasMinterRole,
        escrowPaused:deployment.escrowPaused,tradeId:fresh.tradeId,
        localTrade:stillLocalTrade??fresh.localTrade,matchStatus:matchState?.status,
        otherActiveCount:otherActive.length});
      if((await reader.verifyDeployment()).escrowPaused)throw new Error('Escrow paused since first check');
      await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'SUBMITTED',lastError:null}});
    });
    console.log(`B14 B5-C CLAIMED: intent=${args.intentId} status=SUBMITTED hash=${signed.hash}; network call follows`);
    try {
      // Exactly one broadcast of the identical signed bytes already stored.
      const responseHash=await provider.send('eth_sendRawTransaction',[signed.raw]);
      assertMintRelayHash(responseHash,signed.hash);
      console.log(`B14 B5-C RELAY ACCEPTED: hash=${signed.hash}; no second submission will be attempted`);
    } catch(error){
      const message=sanitizeMintRpcError(error);
      try {
        await withLockedJournal(async(tx,current)=>{
          if(current.status==='SUBMITTED')await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'NEEDS_RECONCILIATION',lastError:message}});
        });
      } catch {console.error('B14 B5-C WARNING: uncertain relay result not persisted; inspect journal');}
      throw new Error(`${message}. Mint MAY have reached Hedera: never rerun --submit; use --reconcile`);
    }
    console.log('B14 B5-C SUBMITTED: journal stays SUBMITTED until independent receipt reconciliation');
    console.log('B14 B5-C SAFETY: no new signing; one transmission of previously stored signed mint');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}
main().catch(error=>{
  console.error('B14 B5-C FAILED:',error instanceof Error?error.message:String(error));
  console.error('Do not delete the journal, rotate encryption key, re-sign, or retry --submit. Inspect/reconcile the existing mint hash.');
  process.exitCode=1;
});
