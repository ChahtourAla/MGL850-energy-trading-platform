/** B17 operator lifecycle recovery: inspect -> plan -> explicit execute -> reconcile -> sync -> verify.
 * Hedera Testnet ONLY. Does not create/fund trades or submit anything from read-only actions.
 */
import { Wallet, Transaction } from 'ethers';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadVerifiedContractArtifacts, createHederaContractReader, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { externalTradeId, assertStoredMatch, assertExistingChainMatches } from './b14-trade-core.mjs';
import { encryptSignedTransaction, decryptSignedTransaction } from './b14-intent-journal-core.mjs';
import { verifySettlement } from './b16-oracle-core.mjs';
import { B17_OPS, argsB17, assertB17, uint, digest, transition, protectedWrite,
  eligibility, quote, sameImmutableIntent, signedMatches, receiptDisposition,
  verifyOperatorEffects, statusDbChange, assertAddresses } from './b17-recovery-core.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const SCHEMA=join(ROOT,'database/schema.prisma');
const lower=x=>String(x).toLowerCase();
const now=()=>BigInt(Math.floor(Date.now()/1000));
const errLabel=err=>{
 const msg=err instanceof Error?err.message:String(err);
 if(/private.?key|ciphertext|DATABASE_URL|signed transaction|0x[a-f0-9]{130,}/i.test(msg))return 'Sensitive transaction/key error (details suppressed)';
 return msg.replace(/(?:https?|postgres(?:ql)?):\/\/[^\s)]+/ig,'[URL REDACTED]').slice(0,290);
};
async function runtime(){
 assertB17(process.env.HEDERA_NETWORK==='testnet'&&process.env.HEDERA_TESTNET_RPC_URL&&process.env.DATABASE_URL,
  'Requires HEDERA_NETWORK=testnet, HEDERA_TESTNET_RPC_URL and DATABASE_URL');
 const artifact=loadVerifiedContractArtifacts();
 const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
 const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
 const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
 try {
  const deployed=await reader.verifyDeployment();
  assertB17(deployed.chainId===296&&deployed.tokenDecimals===6&&deployed.tokenSymbol==='TEUSD','Unexpected chain or token');
  const schema=readFileSync(SCHEMA,'utf8');
  assertB17(schema.includes('model B17OperatorIntent {')&&prisma.b17OperatorIntent,'B17 migration/client not installed');
  const {provider,escrow,token,interfaces}=await reader.getConnection();
  for(const f of ['cancelTrade','expireTrade','refundTrade']){
   assertB17(interfaces.EnergyTradingEscrow.hasFunction(f),'Deployed artifacts do not expose '+f);
  }
  return {prisma,reader,artifact,deployed,provider,escrow,token,interfaces};
 }catch(e){reader.close();await prisma.$disconnect();throw e;}
}
async function load(rt,matchId){
 const {prisma,reader,artifact,provider,escrow,token}=rt;
 const match=await prisma.match.findUnique({where:{id:matchId}});
 assertB17(match&&['SELECTED','TRADE_CREATED'].includes(match.status),'B12 match missing or altered');
 const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
 assertB17(run,'Matching run missing');
 const [allMatches,energies,buyerWallet,sellerWallet,buyerProfile,b14,b16,dbTrade,b17]=await Promise.all([
  prisma.match.findMany({where:{timeSlot:match.timeSlot}}),prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
  prisma.wallet.findUnique({where:{userId:match.buyerId}}),prisma.wallet.findUnique({where:{userId:match.sellerId}}),
  prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
  prisma.b14TransactionIntent.findMany({where:{matchId}}),prisma.b16OracleIntent.findUnique({where:{matchId}}),
  prisma.trade.findUnique({where:{matchId}}),prisma.b17OperatorIntent.findMany({where:{matchId}}),
 ]);
 const terms=assertStoredMatch({match,run,rows:allMatches,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
 const extId=externalTradeId(matchId,artifact.EnergyTradingEscrow.address);
 const onChainId=await reader.getOnChainTradeId(extId);
 assertB17(uint(onChainId,'on-chain trade ID',true)>0n,'No corresponding trade on Hedera');
 const trade=await reader.getTrade(onChainId);
 assertExistingChainMatches(trade,terms,extId);
 const createRow=b14.find(r=>r.operation==='CREATE_TRADE');
 assertB17(b14.every(r=>r.chainId===296&&lower(r.externalTradeId)===lower(extId)),'B14 journal chain/external ID mismatch');
 assertB17(createRow?.status==='CONFIRMED'&&createRow.txHash&&lower(createRow.externalTradeId)===lower(extId),
  'Confirmed original CREATE_TRADE journal entry required');
 const createReceipt=await provider.getTransactionReceipt(createRow.txHash);
 assertB17(createReceipt?.status===1&&lower(createReceipt.to)===lower(artifact.EnergyTradingEscrow.address)&&lower(createReceipt.from)===lower(createRow.signerAddress),
  'Original CREATE_TRADE transaction receipt invalid');
 const createLogs=parseKnownReceiptLogs(createReceipt,artifact,rt.interfaces);
 assertB17(createLogs.some(x=>x.contract==='EnergyTradingEscrow'&&x.event==='TradeCreated'&&String(x.args.onChainTradeId)===String(onChainId)),
  'Missing original TradeCreated event for this ID');
 const operator=createRow.signerAddress;
 assertAddresses(trade.buyer,trade.seller,operator,artifact.EnergyTradingEscrow.address);
 const [hasRole,block,escrowBalance,operatorBalance]=await Promise.all([
  escrow.hasRole(await escrow.OPERATOR_ROLE(),operator),provider.getBlock('latest'),
  token.balanceOf(artifact.EnergyTradingEscrow.address),provider.getBalance(operator),
 ]);
 assertB17(block?.timestamp,'Unable to read latest block time');
 if(dbTrade){
  assertB17(String(dbTrade.onChainTradeId)===String(onChainId),'Prisma trade ID no longer matches chain');
  const candidate=dbTrade.buyerWallet??dbTrade.buyerAddress;
  if(candidate)assertB17(lower(candidate)===lower(trade.buyer),'Prisma buyer address changed');
 }
 if(['AWAITING_DELIVERY','EXPIRED','REFUNDED','COMPLETED'].includes(trade.status)){
  const funding=b14.find(r=>r.operation==='FUND_TRADE');
  assertB17(funding?.status==='CONFIRMED'&&funding.txHash,'Original funding journal missing');
  const receipt=await provider.getTransactionReceipt(funding.txHash);
  assertB17(receipt?.status===1&&lower(receipt.to)===lower(artifact.EnergyTradingEscrow.address)&&lower(receipt.from)===lower(createRow.signerAddress),
   'Original funding receipt missing or wrong signer');
  const required=['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'];
  assertB17(b14.length===5&&required.every(op=>b14.filter(r=>r.operation===op&&r.status==='CONFIRMED'&&r.txHash).length===1),
   'B14 original five transaction intents not complete');
  for(const row of b14){
   const success=await provider.getTransactionReceipt(row.txHash);
   assertB17(success?.status===1&&lower(success.from)===lower(row.signerAddress)&&lower(success.to)===lower(row.targetAddress),
    `Original ${row.operation} receipt mismatch`);
  }
  const logs=parseKnownReceiptLogs(receipt,artifact,rt.interfaces);
  assertB17(logs.some(x=>x.contract==='EnergyTradingEscrow'&&x.event==='TradeFunded'&&String(x.args.onChainTradeId)===String(onChainId)&&
   String(x.args.amount)===String(trade.totalAmountMicrousd)),'Original TradeFunded event mismatch');
 }
 return {rt,match,terms,extId,onChainId,trade,dbTrade,b14,b16,b17,operator,
  hasRole,blockTime:BigInt(block.timestamp),escrowBalance,operatorBalance,
  escrowAddress:artifact.EnergyTradingEscrow.address,tokenAddress:artifact.TestEnergyUSD.address};
}
function rowFor(e,operation){return e.b17.find(x=>x.operation===operation)??null;}
function statusReport(e,extra={}){
 console.log('B17 CHECK: '+JSON.stringify({matchId:e.match.id,chainId:296,externalTradeId:e.extId,onChainTradeId:e.onChainId,
  status:e.trade.status,dbStatus:e.dbTrade?.status??'NO_TRADE_ROW',amountMicroTEUSD:e.trade.totalAmountMicrousd,
  deadline:new Date(Number(e.trade.deliveryDeadline)*1000).toISOString(),chainTime:new Date(Number(e.blockTime)*1000).toISOString(),
  operator:e.operator,hasOperatorRole:e.hasRole,escrowBalance:e.escrowBalance.toString(),
  b16Intent:e.b16?.status??'NONE',operations:Object.fromEntries(e.b17.map(r=>[r.operation,{status:r.status,txHash:r.txHash,synced:!!r.syncedAt}])),...extra},null,2));
}
function immutablePlan(e,operation){
 const rule=B17_OPS[operation];assertB17(rule,'Unknown operator action');
 const callData=e.rt.interfaces.EnergyTradingEscrow.encodeFunctionData(rule.method,[BigInt(e.onChainId)]);
 return {matchId:e.match.id,operation,externalTradeId:e.extId,onChainTradeId:e.onChainId,chainId:296,
  signerAddress:lower(e.operator),targetAddress:lower(e.escrowAddress),buyerAddress:lower(e.trade.buyer),
  totalAmountMicrousd:e.trade.totalAmountMicrousd,callDataSha256:digest(callData),callData,buyer:e.trade.buyer};
}
async function lock(e,fn){
 return e.rt.prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT 1::int FROM pg_advisory_xact_lock(296,hashtext(${e.match.id}))`;
  const m=await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id"=${e.match.id}::uuid FOR UPDATE`;
  assertB17(m.length===1,'Match changed during lifecycle journal operation');
  return fn(tx);
 },{timeout:90_000,maxWait:10_000});
}
async function validate(e,operation,{ignoreIntentId=null}={}){
 const prior=rowFor(e,'EXPIRE');
 const decision=eligibility({operation,trade:e.trade,dbTrade:e.dbTrade,chainNow:e.blockTime,
  paused:e.rt.deployed.escrowPaused,operatorHasRole:e.hasRole,escrowBalance:e.escrowBalance,b16Journal:e.b16,expireJournal:prior});
 if(operation==='REFUND')await verifyReceipt(e,prior,{allowLaterRefund:false});
 assertB17(!e.b17.some(r=>r.id!==ignoreIntentId&&['SIGNED','SUBMITTED','NEEDS_RECONCILIATION'].includes(r.status)),'Another B17 operation has unresolved signing/broadcast');
 return decision;
}
function wallet(e){
 assertB17(/^0x[0-9a-f]{64}$/i.test(process.env.HEDERA_OPERATOR_PRIVATE_KEY??''),'Existing HEDERA_OPERATOR_PRIVATE_KEY required only for signing');
 const w=new Wallet(process.env.HEDERA_OPERATOR_PRIVATE_KEY);
 assertB17(lower(w.address)===lower(e.operator),'Local operator key differs from original B14 signer');return w;
}
function signedRaw(row,p){
 assertB17(row?.signedTxCiphertext&&row.signedTxIv&&row.signedTxTag&&row.txHash,'Encrypted journal recovery bytes missing');
 const raw=decryptSignedTransaction({ciphertext:row.signedTxCiphertext,iv:row.signedTxIv,tag:row.signedTxTag},process.env.B14_SIGNED_TX_KEY_B64,row.id);
 const decoded=Transaction.from(raw);signedMatches(decoded,row,p);return raw;
}
async function stage(e,p){
 return lock(e,async tx=>{
  const b16=await tx.b16OracleIntent.findUnique({where:{matchId:e.match.id}});
  assertB17(!b16||b16.status==='REVERTED','Concurrent B16 oracle intent blocks B17 operator action');
  const existing=await tx.b17OperatorIntent.findUnique({where:{matchId_operation:{matchId:e.match.id,operation:p.operation}}});
  if(existing){sameImmutableIntent(existing,p);return existing;}
  const other=await tx.b17OperatorIntent.findMany({where:{matchId:e.match.id}});
  assertB17(other.every(x=>!['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION'].includes(x.status)),
   'Previous operator operation unresolved');
  return tx.b17OperatorIntent.create({data:{matchId:p.matchId,operation:p.operation,externalTradeId:p.externalTradeId,
   onChainTradeId:p.onChainTradeId,chainId:296,signerAddress:p.signerAddress,targetAddress:p.targetAddress,
   buyerAddress:p.buyerAddress,totalAmountMicrousd:p.totalAmountMicrousd,callDataSha256:p.callDataSha256,status:'PLANNED'}});
 });
}
async function seal(e,p,row){
 assertB17(row.status==='PLANNED','Only PLANNED intent can be signed');
 assertB17(process.env.B14_SIGNED_TX_KEY_B64,'Existing B14_SIGNED_TX_KEY_B64 required for encrypted recovery');
 const w=wallet(e);
 const [latest,pending,estimate,fee,balance]=await Promise.all([
  e.rt.provider.getTransactionCount(e.operator,'latest'),e.rt.provider.getTransactionCount(e.operator,'pending'),
  e.rt.provider.estimateGas({from:e.operator,to:p.targetAddress,data:p.callData,value:0n}),
  e.rt.provider.getFeeData(),e.rt.provider.getBalance(e.operator),
 ]);
 assertB17(latest===pending,'Operator nonce queue contains pending transactions');
 const gas=quote({estimate,gasPrice:fee.gasPrice,balance});
 const raw=await w.signTransaction({type:0,chainId:296,nonce:latest,to:p.targetAddress,value:0n,data:p.callData,
  gasLimit:gas.gasLimit,gasPrice:gas.gasPrice});
 const decoded=Transaction.from(raw);
 assertB17(lower(decoded.from)===p.signerAddress&&lower(decoded.to)===p.targetAddress&&lower(decoded.data)===lower(p.callData),
  'Signed B17 transaction differs from planned calldata');
 const saved=await lock(e,async tx=>{
  const current=await tx.b17OperatorIntent.findUnique({where:{id:row.id}});
  assertB17(current?.status==='PLANNED','B17 status changed before sealing');sameImmutableIntent(current,p);
  const [n1,n2]=await Promise.all([e.rt.provider.getTransactionCount(e.operator,'latest'),e.rt.provider.getTransactionCount(e.operator,'pending')]);
  assertB17(n1===latest&&n2===latest,'Operator nonce changed before sealing');
  const blocker=await tx.b17OperatorIntent.findFirst({where:{signerAddress:p.signerAddress,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']},NOT:{id:row.id}}});
  assertB17(!blocker,'Another operator journal entry has unresolved signed transaction');
  const enc=encryptSignedTransaction(raw,process.env.B14_SIGNED_TX_KEY_B64,row.id);transition(current.status,'SIGNED');
  return tx.b17OperatorIntent.update({where:{id:row.id},data:{status:'SIGNED',nonce:String(latest),txHash:decoded.hash,
   signedTxCiphertext:enc.ciphertext,signedTxIv:enc.iv,signedTxTag:enc.tag}});
 });
 signedRaw(saved,p);console.log(`B17 SEALED ${p.operation}: ${saved.txHash}; encrypted and NOT broadcast`);return saved;
}
async function sendOnce(e,p,row){
 assertB17(row.status==='SIGNED','Only SIGNED may broadcast');
 signedRaw(row,p);
 const [latest,pending,known,receipt]=await Promise.all([
  e.rt.provider.getTransactionCount(e.operator,'latest'),e.rt.provider.getTransactionCount(e.operator,'pending'),
  e.rt.provider.getTransaction(row.txHash),e.rt.provider.getTransactionReceipt(row.txHash)]);
 assertB17(latest===Number(row.nonce)&&pending===latest&&!known&&!receipt,'Operator nonce or transaction seen; do not resubmit');
 const fresh=await load(e.rt,e.match.id);
 await validate(fresh,p.operation,{ignoreIntentId:row.id});
 const current=await fresh.rt.prisma.b17OperatorIntent.findUnique({where:{id:row.id}});
 assertB17(current?.status==='SIGNED'&&current.txHash===row.txHash,'B17 signed intent was replaced');
 // Fresh chain check is executed before the database claim. Recheck nonce under lock.
 await lock(e,async tx=>{
  const r=await tx.b17OperatorIntent.findUnique({where:{id:row.id}});
  assertB17(r?.status==='SIGNED'&&r.txHash===row.txHash,'B17 claim no longer unique');
  const b16=await tx.b16OracleIntent.findUnique({where:{matchId:e.match.id}});
  assertB17(!b16||b16.status==='REVERTED','Concurrent B16 intent blocks broadcast');
  const blocking=await tx.b17OperatorIntent.findFirst({where:{signerAddress:p.signerAddress,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']},NOT:{id:row.id}}});
  assertB17(!blocking,'Another unresolved operator transaction blocks broadcast');
  const [n1,n2]=await Promise.all([e.rt.provider.getTransactionCount(e.operator,'latest'),e.rt.provider.getTransactionCount(e.operator,'pending')]);
  assertB17(n1===latest&&n2===latest,'Nonce moved while claiming broadcast');
  transition('SIGNED','SUBMITTED');await tx.b17OperatorIntent.update({where:{id:row.id},data:{status:'SUBMITTED'}});
 });
 console.log(`B17 CLAIMED ${p.operation}: ${row.txHash} status=SUBMITTED; one RPC submission attempt`);
 try{
  const raw=signedRaw(row,p);
  const returned=await e.rt.provider.send('eth_sendRawTransaction',[raw]);
  assertB17(lower(returned)===lower(row.txHash),'RPC returned a different transaction hash');
  console.log(`B17 RELAY ACCEPTED: ${returned}`);
 }catch{
  try{await lock(e,async tx=>{
   const r=await tx.b17OperatorIntent.findUnique({where:{id:row.id}});
   if(r?.status==='SUBMITTED')await tx.b17OperatorIntent.update({where:{id:row.id},data:{status:'NEEDS_RECONCILIATION',lastError:'Relay outcome unknown. Never resubmit; reconcile exact hash.'}});
  });}catch{console.error('B17 journal may remain SUBMITTED; inspect manually');}
  throw new Error('B17 broadcast result uncertain. Never repeat --execute; use --action reconcile for same hash');
 }
}
async function verifyReceipt(e,row,{allowLaterRefund=true}={}){
 assertB17(row?.operation&&row.txHash&&row.status!=='PLANNED','B17 intent not signed');
 const p=immutablePlan(e,row.operation);sameImmutableIntent(row,p);
 signedRaw(row,p); // protects against tampered calldata, signer, chain, nonce, and hash
 const [tx,receipt]=await Promise.all([e.rt.provider.getTransaction(row.txHash),e.rt.provider.getTransactionReceipt(row.txHash)]);
 const disposition=receiptDisposition({row,tx,receipt,plan:p});
 if(disposition==='CONFIRMED'){
  const observed=await e.rt.reader.getTrade(e.onChainId);
  const refundRow=e.b17.find(x=>x.operation==='REFUND');
  const allowed=allowLaterRefund&&row.operation==='EXPIRE'&&observed.status==='REFUNDED'&&refundRow?.status==='CONFIRMED';
  // Verify the successor receipt independently before accepting the later REFUNDED status.
  if(allowed)assertB17(await verifyReceipt(e,refundRow,{allowLaterRefund:false})==='CONFIRMED',
   'Subsequent refund receipt must be verified before historical expiration audit');
  const eventTrade=allowed?{...observed,status:'EXPIRED',statusCode:6}:observed;
  const events=parseKnownReceiptLogs(receipt,e.rt.artifact,e.rt.interfaces);
  verifyOperatorEffects({operation:row.operation,events,trade:eventTrade,plan:p,token:e.tokenAddress,escrow:e.escrowAddress});
 }
 return disposition;
}
async function reconcile(e,operation){
 const row=rowFor(e,operation);assertB17(row,'No B17 intent for this operation');
 assertB17(!['PLANNED','SIGNED'].includes(row.status),'Intent has not been broadcast; investigate, never resend automatically');
 assertB17(row.status!=='REVERTED','Receipt reverted; do not reuse this journal');
 const result=await verifyReceipt(e,row);
 if(row.status==='CONFIRMED'){
  assertB17(result==='CONFIRMED','Previously confirmed receipt no longer verifiable');
  console.log(`B17 ALREADY CONFIRMED: ${operation} ${row.txHash}`);return 'CONFIRMED';
 }
 const next=result==='CONFIRMED'?'CONFIRMED':result==='REVERTED'?'REVERTED':result==='UNKNOWN'?'NEEDS_RECONCILIATION':row.status;
 const saved=await lock(e,async tx=>{
  const current=await tx.b17OperatorIntent.findUnique({where:{id:row.id}});
  assertB17(current?.txHash===row.txHash,'Journal hash changed during reconcile');
  if(current.status===next)return current;
  transition(current.status,next);
  return tx.b17OperatorIntent.update({where:{id:row.id},data:{status:next,
   ...(next==='CONFIRMED'?{confirmedAt:new Date(),lastError:null}:{}),
   ...(next==='NEEDS_RECONCILIATION'?{lastError:'Receipt not indexed; no re-broadcast allowed'}:{})}});
 });
 console.log(`B17 RECONCILED: ${operation} ${row.status}->${saved.status}, hash=${row.txHash}; no new broadcast`);
 return saved.status;
}
async function sync(e,operation){
 const row=rowFor(e,operation);assertB17(row?.status==='CONFIRMED'&&row.confirmedAt,'First reconcile a confirmed B17 receipt');
 assertB17(await verifyReceipt(e,row)==='CONFIRMED','Missing on-chain proof');
 await lock(e,async tx=>{
  const current=await tx.b17OperatorIntent.findUnique({where:{id:row.id}});
  assertB17(current?.status==='CONFIRMED'&&current.txHash===row.txHash,'Journal changed before DB sync');
  const trade=await tx.trade.findUnique({where:{matchId:e.match.id}});
  const choice=statusDbChange(operation,trade?.status??null);
  if(trade)assertB17(String(trade.onChainTradeId)===String(e.onChainId),'Prisma trade changed ID');
  if(choice==='UPDATE')await tx.trade.update({where:{matchId:e.match.id},data:{status:B17_OPS[operation].post}});
  if(!current.syncedAt)await tx.b17OperatorIntent.update({where:{id:row.id},data:{syncedAt:new Date()}});
  if(choice==='NO_TRADE_ROW')console.log('B17 CANCEL: no B15 Trade row exists for unfunded trade; operator journal is the canonical off-chain record');
 });
 console.log(`B17 DB SYNC PASS: ${operation} -> ${B17_OPS[operation].post}; no chain transaction`);
}
async function verify(e,operation){
 if(operation==='SETTLEMENT'){
  assertB17(e.trade.status==='COMPLETED'&&e.dbTrade?.status==='COMPLETED','B16 settlement not complete on both layers');
  const row=e.b16;assertB17(row?.status==='CONFIRMED'&&row.syncedAt&&row.txHash,'B16 oracle journal not fully synced');
  const receipt=await e.rt.provider.getTransactionReceipt(row.txHash),tx=await e.rt.provider.getTransaction(row.txHash);
  assertB17(receipt?.status===1&&lower(receipt.to)===lower(e.escrowAddress)&&lower(receipt.from)===lower(row.signerAddress),'B16 confirmation receipt missing');
  const calldata=e.rt.interfaces.EnergyTradingEscrow.encodeFunctionData('confirmDelivery',[BigInt(e.onChainId),BigInt(row.evidencePayload.deliveredWh),row.evidenceHash]);
  assertB17(tx&&lower(tx.hash)===lower(row.txHash)&&lower(tx.data)===lower(calldata)&&digest(calldata)===row.callDataSha256,'B16 immutable settlement call mismatch');
  verifySettlement({events:parseKnownReceiptLogs(receipt,e.rt.artifact,e.rt.interfaces),trade:e.trade,
   proof:{deliveredWh:row.evidencePayload.deliveredWh,evidenceHash:row.evidenceHash},onChainId:e.onChainId,
   seller:e.trade.seller,escrow:e.escrowAddress,token:e.tokenAddress,amount:e.trade.totalAmountMicrousd});
  console.log(`B17 SETTLEMENT VERIFY PASS: seller paid exact ${e.trade.totalAmountMicrousd} base TEUSD units; B16 complete; no writes`);return;
 }
 const row=rowFor(e,operation);assertB17(row?.status==='CONFIRMED'&&row.syncedAt,'B17 journal not confirmed and synced');
 assertB17(await verifyReceipt(e,row)==='CONFIRMED','B17 tx or effect verification failed');
 if(operation==='CANCEL')assertB17(!e.dbTrade||e.dbTrade.status==='CANCELLED','Prisma cancellation mismatch');
 else if(operation==='EXPIRE')assertB17(['EXPIRED','REFUNDED'].includes(e.dbTrade?.status),'Prisma expiry/refund mismatch');
 else assertB17(e.dbTrade?.status==='REFUNDED','Prisma refund mismatch');
 console.log(`B17 VERIFY PASS: ${operation}, events/receipt/status and Prisma journal consistent; no writes`);
}
async function execute(e,operation){
 assertB17(process.env.B17_ONCHAIN_CONFIRM===`I_AUTHORIZE_B17_${operation}_ON_HEDERA_TESTNET`,
  `Explicit consent B17_ONCHAIN_CONFIRM=I_AUTHORIZE_B17_${operation}_ON_HEDERA_TESTNET required`);
 protectedWrite(e.onChainId,operation,process.env.B17_PROTECTED_TRADE_CONFIRM);
 await validate(e,operation,{ignoreIntentId:rowFor(e,operation)?.id??null});
 const p=immutablePlan(e,operation);
 const already=rowFor(e,operation);
 if(already){
  sameImmutableIntent(already,p);
  assertB17(['PLANNED','SIGNED'].includes(already.status),`B17 ${operation} already ${already.status}; use reconcile/verify, never resubmit`);
 }
 let row=await stage(e,p);
 if(row.status==='PLANNED')row=await seal(e,p,row);
 else signedRaw(row,p); // persisted SIGNED with no send claim; may safely claim once

 await sendOnce(e,p,row);
 const latest=await load(e.rt,e.match.id);
 const result=await reconcile(latest,operation);
 if(result!=='CONFIRMED')throw new Error('B17 relay accepted but confirmation pending. Use reconcile only.');
 const confirmed=await load(e.rt,e.match.id);await sync(confirmed,operation);
 await verify(await load(e.rt,e.match.id),operation);
}
async function main(){
 const args=argsB17(process.argv.slice(2));
 if(args.action==='execute')assertB17(process.env.B17_ONCHAIN_CONFIRM===`I_AUTHORIZE_B17_${args.operation}_ON_HEDERA_TESTNET`,
  'Explicit B17 on-chain consent required');
 const rt=await runtime();
 try{
  const e=await load(rt,args.matchId);
  if(args.action==='inspect'){statusReport(e,{action:'INSPECT_READ_ONLY'});console.log('B17 INSPECT PASS: no signing, blockchain writes or DB mutations');return;}
  if(args.action==='plan'){
   const result=await validate(e,args.operation),p=immutablePlan(e,args.operation);
   statusReport(e,{action:'PLAN_READ_ONLY',operation:args.operation,transition:result,callDataSha256:p.callDataSha256,
    protectedTrade:e.onChainId==='2'});
   console.log('B17 PLAN PASS: eligible for separate explicitly authorized execution; no writes');return;
  }
  if(args.action==='execute')return execute(e,args.operation);
  if(args.action==='reconcile'){statusReport(e,{action:'RECONCILE_EXISTING_TX'});return reconcile(e,args.operation);}
  if(args.action==='sync'){
   assertB17(process.env.B17_DB_SYNC_CONFIRM==='SYNC_CONFIRMED_B17_TRADE_STATUS_ONLY','B17 DB sync consent required');
   return sync(e,args.operation);
  }
  if(args.action==='verify'){statusReport(e,{action:'VERIFY_READ_ONLY',operation:args.operation});return verify(e,args.operation);}
 }finally{rt.reader.close();await rt.prisma.$disconnect();}
}
main().catch(e=>{console.error('B17 STOP: '+errLabel(e));console.error('No automatic retry, replacement signer, manual journal edits, or protected-trade transaction. Reconcile the existing hash after any uncertain relay.');process.exitCode=1;});
