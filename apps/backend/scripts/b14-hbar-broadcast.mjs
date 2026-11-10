/**
 * B14 Phase B4: broadcast EXACTLY the already-signed HBAR transaction, once.
 * Default PREVIEW is strictly read-only. --submit requires explicit consent and
 * atomically claims SUBMITTED in PostgreSQL before any eth_sendRawTransaction.
 * --reconcile only checks the persisted hash and updates journal state; it never resends.
 * No signing/private-key access; no new intent creation; no transaction replacement.
 */
import { Transaction } from 'ethers';
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import {
  parseBroadcastArgs, requireBroadcastPermission, expectedTopupIntent,
  verifyJournalForB4, decodeVerifiedSigned, observedState,
  assertSubmitAllowed, assertRelayHash, decideReconciliation, sanitizeBroadcastError,
} from './b14-hbar-broadcast-core.mjs';

async function main() {
  const args=parseBroadcastArgs(process.argv.slice(2));
  requireBroadcastPermission(args,process.env);
  if (process.env.HEDERA_NETWORK!=='testnet' || !process.env.HEDERA_TESTNET_RPC_URL || !process.env.DATABASE_URL || !process.env.B14_SIGNED_TX_KEY_B64) {
    throw new Error('Requires HEDERA_NETWORK=testnet, Hedera RPC, DATABASE_URL and B14_SIGNED_TX_KEY_B64');
  }
  if (args.action==='SUBMIT' && args.hbar!=='0.2') throw new Error('This B4 broadcast is restricted to the already-approved 0.2 HBAR transfer');
  const artifacts=loadVerifiedContractArtifacts();
  const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try {
    const [match,journal]=await Promise.all([
      prisma.match.findUnique({where:{id:args.matchId}}),
      prisma.b14TransactionIntent.findUnique({where:{id:args.intentId}}),
    ]);
    if (!match) throw new Error('B12 match is missing');
    if (args.action==='SUBMIT' && match.status!=='SELECTED') throw new Error('B12 match changed; refuse new submission');
    const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
    if (!run) throw new Error('B12 matching run missing');
    const [matches,energies,buyerWallet,sellerWallet,buyerProfile,localTrade]=await Promise.all([
      prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
      prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
      prisma.wallet.findUnique({where:{userId:match.buyerId}}),
      prisma.wallet.findUnique({where:{userId:match.sellerId}}),
      prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
      prisma.trade.findUnique({where:{matchId:args.matchId}}),
    ]);
    const terms=assertStoredMatch({match,run,rows:matches,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
    if (!buyerWallet?.hederaAccountId) throw new Error('Buyer Hedera wallet not onboarded');
    const extId=externalTradeId(match.id,artifacts.EnergyTradingEscrow.address);
    const plan=expectedTopupIntent(args,extId,terms.buyer);
    verifyJournalForB4(journal,plan,args);
    const signed=decodeVerifiedSigned(journal,process.env.B14_SIGNED_TX_KEY_B64,plan,Transaction.from);
    const deployment=await reader.verifyDeployment();
    if (deployment.chainId!==296) throw new Error('Wrong Hedera network');
    // A previously broadcast transfer must remain reconcilable even if the
    // escrow is subsequently paused or the operator role is later revoked.
    if (args.action==='SUBMIT' && deployment.escrowPaused) throw new Error('Hedera escrow paused; refuse new submission');
    const [role,chainTradeId]=await Promise.all([
      reader.hasOperatorRole(args.operatorAddress), reader.getOnChainTradeId(extId),
    ]);
    if (args.action==='SUBMIT' && !role) throw new Error('Selected operator no longer has OPERATOR_ROLE');
    if (args.action==='SUBMIT' && (localTrade || chainTradeId!=='0')) throw new Error('Trade was created since funding stage; manual reconciliation required');
    const {provider}=await reader.getConnection();

    async function observe() {
      // All calls are reads. Never equate a null receipt with a definitive failure on Hedera.
      const [receipt,networkTx,latest,pending,operatorBalanceWei,buyerBalanceWei]=await Promise.all([
        provider.getTransactionReceipt(signed.hash),
        provider.getTransaction(signed.hash),
        provider.getTransactionCount(args.operatorAddress,'latest'),
        provider.getTransactionCount(args.operatorAddress,'pending'),
        provider.getBalance(args.operatorAddress), provider.getBalance(terms.buyer),
      ]);
      const state=observedState({receipt,networkTx,nonceLatest:latest,noncePending:pending},signed);
      return {state,receipt,latest,pending,operatorBalanceWei,buyerBalanceWei};
    }

    const observation=await observe();
    console.log('B14 B4 CHECK: '+JSON.stringify({
      chainId:deployment.chainId,matchId:match.id,intentId:journal.id,operation:journal.operation,
      journalStatus:journal.status,txHash:signed.hash,signer:plan.signerAddress,buyer:plan.targetAddress,
      amountHbar:args.hbar,storedNonce:String(signed.nonce),
      chainLatestNonce:String(observation.latest),chainPendingNonce:String(observation.pending),
      maxGasFeeWei:signed.maxFeeWei.toString(),
      chainState:observation.state,buyerHbarWei:observation.buyerBalanceWei.toString(),
      action:args.action,
    },null,2));
    if (args.action==='PREVIEW') {
      console.log('B14 B4 PREVIEW PASS: read-only; no signing, database updates, or blockchain broadcast');
      return;
    }

    async function withLockedJournal(callback) {
      return prisma.$transaction(async (tx)=>{
        // Same advisory lock used by B3 signing, plus exact journal row FOR UPDATE.
        await tx.$queryRaw`SELECT 1::int AS acquired FROM pg_advisory_xact_lock(296, hashtext(${args.operatorAddress}))`;
        const found=await tx.$queryRaw`SELECT "id" FROM "b14_transaction_intents" WHERE "id" = ${args.intentId}::uuid FOR UPDATE`;
        if (!Array.isArray(found)||found.length!==1) throw new Error('Signed journal row disappeared');
        const current=await tx.b14TransactionIntent.findUnique({where:{id:args.intentId}});
        verifyJournalForB4(current,plan,args);
        if (current.txHash.toLowerCase()!==signed.hash) throw new Error('Signed transaction hash changed under lock');
        return callback(tx,current);
      },{timeout:45_000,maxWait:10_000});
    }

    if (args.action==='RECONCILE') {
      // Re-observe under lock; nothing writes to Hedera in this mode.
      const result=await withLockedJournal(async(tx,current)=>{
        const fresh=await observe();
        const transition=decideReconciliation(current,fresh.state);
        if (!transition) return {from:current.status,to:current.status,state:fresh.state,changed:false,buyerHbarWei:fresh.buyerBalanceWei.toString()};
        const update={status:transition,lastError:null};
        if (transition==='CONFIRMED') update.confirmedAt=new Date();
        if (transition==='NEEDS_RECONCILIATION') update.lastError='Transaction not presently visible through RPC; do not automatically resubmit';
        await tx.b14TransactionIntent.update({where:{id:current.id},data:update});
        return {from:current.status,to:transition,state:fresh.state,changed:true,buyerHbarWei:fresh.buyerBalanceWei.toString()};
      });
      console.log('B14 B4 RECONCILED: '+JSON.stringify({...result,txHash:signed.hash,intentId:args.intentId}));
      console.log('B14 B4 RECONCILE SAFE: no new transaction signed or broadcast');
      return;
    }

    // --submit: claim exactly once, before the external side effect. A crash after
    // claim leaves SUBMITTED, intentionally requiring reconciliation rather than replay.
    await withLockedJournal(async(tx,current)=>{
      const fresh=await observe();
      if (fresh.buyerBalanceWei>=50_000_000_000_000_000n) {
        throw new Error('Buyer already has at least 0.05 HBAR; refuse duplicate funding');
      }
      // Last-minute blockchain business guards while the journal is locked.
      const [stillRole,stillOnChainId,stillDeployment,stillLocalTrade]=await Promise.all([
        reader.hasOperatorRole(args.operatorAddress),reader.getOnChainTradeId(extId),
        reader.verifyDeployment(),tx.trade.findUnique({where:{matchId:args.matchId}}),
      ]);
      if (!stillRole || stillDeployment.escrowPaused || stillOnChainId!=='0' || stillLocalTrade) {
        throw new Error('Trade/operator state changed before broadcast; stop');
      }
      const currentMatch=await tx.match.findUnique({where:{id:args.matchId},select:{status:true}});
      if (currentMatch?.status!=='SELECTED') throw new Error('Match no longer selected at broadcast claim');
      assertSubmitAllowed(current,fresh.state,fresh.operatorBalanceWei,signed);
      const others=await tx.b14TransactionIntent.findMany({
        where:{signerAddress:args.operatorAddress,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']},id:{not:args.intentId}},
        select:{id:true,status:true},
      });
      if (others.length) throw new Error('Another unresolved transaction uses this operator; stop');
      await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'SUBMITTED',lastError:null}});
    });
    console.log(`B14 B4 CLAIMED: intent=${args.intentId} status=SUBMITTED hash=${signed.hash}; network call follows`);
    try {
      // Only one broadcast, of precisely the existing encrypted signed envelope.
      const responseHash=await provider.send('eth_sendRawTransaction',[signed.raw]);
      assertRelayHash(responseHash,signed.hash);
      console.log(`B14 B4 RELAY ACCEPTED: hash=${signed.hash}; no second submission will be attempted`);
    } catch(error) {
      const msg=sanitizeBroadcastError(error);
      try {
        await withLockedJournal(async(tx,current)=>{
          if (current.status==='SUBMITTED') await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'NEEDS_RECONCILIATION',lastError:msg}});
        });
      } catch { console.error('B14 B4 WARNING: could not record uncertain RPC outcome; inspect journal'); }
      throw new Error(`${msg}. The transfer MAY have reached Hedera. Never retry --submit; run --reconcile after RPC indexing.`);
    }
    // Receipt indexing may lag on Hedera. Leave SUBMITTED until explicitly reconciled.
    console.log('B14 B4 SUBMITTED: journal remains SUBMITTED pending confirmed receipt; next command is --reconcile');
    console.log('B14 B4 SAFETY: signed the transaction zero times in B4; submitted stored bytes exactly once');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}
main().catch((error)=>{
  console.error('B14 B4 FAILED:',error instanceof Error?error.message:String(error));
  console.error('Never delete an intent, re-sign, or rerun --submit after an uncertain outcome. Reconcile stored hash first.');
  process.exitCode=1;
});
