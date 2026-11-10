/** B16 one-package oracle: preflight, simulated evidence, guarded single-send, reconciliation, DB sync. */
import { Wallet, Transaction } from 'ethers';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectB16Python, b16PythonEnv, b16PythonFailure } from './b16-python-runner.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { externalTradeId, assertStoredMatch, assertExistingChainMatches } from './b14-trade-core.mjs';
import { encryptSignedTransaction, decryptSignedTransaction } from './b14-intent-journal-core.mjs';
import {
 argsB16, requireB16, unsigned, validateWindow, simulationPlan, validateDelivery, evidenceCommitment,
 checkPrerequisites, feeQuote, transitions, receiptResult, verifySettlement,
 safeDbProjection, parseModel,
} from './b16-oracle-core.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const SCHEMA=join(ROOT,'database/schema.prisma');
const LOW=x=>String(x).toLowerCase();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sec=()=>BigInt(Math.floor(Date.now()/1000));
const canonical=x=>JSON.stringify(x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=x=>createHash('sha256').update(x).digest('hex');
function redact(e){const t=e instanceof Error?e.message:String(e);if(/0x[0-9a-f]{130,}/i.test(t)||/private.?key|ciphertext|database_url/i.test(t))return 'Sensitive key or network error (details redacted)';return t.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s)]+/ig,'[URL_REDACTED]').slice(0,240);}
function addressFromEnv({required=false}={}){
 const key=process.env.HEDERA_ORACLE_PRIVATE_KEY;
 if(required)requireB16(typeof key==='string'&&/^0x[0-9a-f]{64}$/i.test(key),'HEDERA_ORACLE_PRIVATE_KEY must be set locally for execution');
 let wallet=null;
 if(key&&/^0x[0-9a-f]{64}$/i.test(key))wallet=new Wallet(key);
 const address=wallet?.address??process.env.B16_ORACLE_PUBLIC_ADDRESS;
 requireB16(/^0x[a-f0-9]{40}$/i.test(address??''),'Set oracle key or B16_ORACLE_PUBLIC_ADDRESS for safe public preflight');
 if(process.env.B16_ORACLE_PUBLIC_ADDRESS)requireB16(LOW(process.env.B16_ORACLE_PUBLIC_ADDRESS)===LOW(address),'Oracle public address differs from key');
 return {address,wallet};
}
async function runtime(){
 requireB16(process.env.HEDERA_NETWORK==='testnet'&&process.env.HEDERA_TESTNET_RPC_URL&&process.env.DATABASE_URL,'Testnet RPC and DATABASE_URL required');
 const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
 const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
 const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
 try {
  const deployed=await reader.verifyDeployment();requireB16(deployed.chainId===296&&deployed.tokenDecimals===6&&deployed.tokenSymbol==='TEUSD','Canonical Testnet token/chain mismatch');
  const artifact=loadVerifiedContractArtifacts();
  const schema=readFileSync(SCHEMA,'utf8');const deliveryModel=parseModel(schema,'DeliveryRecord');
  requireB16(schema.includes('model B16OracleIntent {'),'B16 Prisma journal model is missing; apply migration and regenerate Prisma');
  requireB16(prisma.b16OracleIntent&&prisma.deliveryRecord,'B16 Prisma Client not generated after migration');
  return {prisma,reader,artifact,deliveryModel,deployed};
 }catch(e){reader.close();await prisma.$disconnect();throw e;}
}
function deliveryDbData(e,record,hash){
 const tradeId=e.dbTrade.id??e.dbTrade.tradeId;
 const src={id:record.deliveryId,recordId:record.deliveryId,deliveryId:record.deliveryId,tradeId,onChainTradeId:String(record.onChainTradeId),sellerId:record.sellerId,buyerId:record.buyerId,
  expectedWh:record.expectedWh,deliveredWh:record.deliveredWh,timeSlot:record.timeSlot,status:'CONFIRMED',evidenceHash:hash};
 return safeDbProjection(e.rt.deliveryModel,src);
}
async function load(rt,matchId){
 const {prisma,reader,artifact}=rt;
 const match=await prisma.match.findUnique({where:{id:matchId}});requireB16(match?.status==='SELECTED','Selected B12 match missing');
 const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});requireB16(run,'B12 matching run missing');
 const [rows,energies,buyerWallet,sellerWallet,buyerProfile,journal,dbTrade,intent]=await Promise.all([
  prisma.match.findMany({where:{timeSlot:match.timeSlot}}),prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
  prisma.wallet.findUnique({where:{userId:match.buyerId}}),prisma.wallet.findUnique({where:{userId:match.sellerId}}),
  prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
  prisma.b14TransactionIntent.findMany({where:{matchId}}),prisma.trade.findUnique({where:{matchId}}),
  prisma.b16OracleIntent.findUnique({where:{matchId}}),
 ]);
 const terms=assertStoredMatch({match,run,rows,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
 const extId=externalTradeId(matchId,artifact.EnergyTradingEscrow.address);
 const id=await reader.getOnChainTradeId(extId);requireB16(unsigned(id,'chainTradeId',true)>0n,'Trade not found on chain');
 const trade=await reader.getTrade(id);assertExistingChainMatches(trade,terms,extId);
 requireB16(String(trade.totalAmountMicrousd)===String(terms.totalAmountMicrousd),'On-chain payment is not B12 amount');
 requireB16(dbTrade,'B15 Prisma Trade missing; synchronize B15 first');
 requireB16(String(dbTrade.onChainTradeId)===String(id)&&LOW(dbTrade.buyerWallet??dbTrade.buyerAddress??terms.buyer)===LOW(terms.buyer),'B15 trade linkage/buyer mismatch');
 const conn=await reader.getConnection();const {provider,escrow,token,interfaces}=conn;
 const {address:oracle}=addressFromEnv();
 const [hasRole,escrowBalance,oracleHbar]=await Promise.all([
  escrow.hasRole(await escrow.ORACLE_ROLE(),oracle),token.balanceOf(artifact.EnergyTradingEscrow.address),provider.getBalance(oracle),
 ]);
 const required=['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'];
 requireB16(journal.length===5&&required.every(op=>journal.filter(r=>r.operation===op&&r.status==='CONFIRMED'&&r.txHash).length===1),'B14 journal must have exactly five confirmed operations');
 const receipts=await Promise.all(journal.map(async r=>[r.operation,await provider.getTransactionReceipt(r.txHash),r]));
 for(const [operation,r,entry] of receipts){
   requireB16(r?.status===1&&LOW(r.hash??r.transactionHash)===LOW(entry.txHash)&&LOW(r.from)===LOW(entry.signerAddress)&&LOW(r.to)===LOW(entry.targetAddress),`B14 ${operation} has no matching successful on-chain receipt`);
 }
 const fundingReceipt=receipts.find(x=>x[0]==='FUND_TRADE')[1];
 const fundingEvents=parseKnownReceiptLogs(fundingReceipt,artifact,interfaces);
 requireB16(fundingEvents.filter(x=>x.contract==='EnergyTradingEscrow'&&x.event==='TradeFunded'&&String(x.args?.onChainTradeId)===String(id)&&String(x.args?.amount)===String(terms.totalAmountMicrousd)).length===1,'B14 funding event mismatch');
 const tradeId=dbTrade.id??dbTrade.tradeId;requireB16(UUID.test(tradeId??''),'B15 Trade must expose backend UUID id/tradeId');
 const deliveries=await prisma.deliveryRecord.findMany({where:{tradeId}});
 return {rt,match,terms,extId,id,trade,dbTrade,tradeId,journal,intent,deliveries,provider,escrow,token,interfaces,oracle,oracleHbar,hasRole,
  escrowBalance,escrowAddress:artifact.EnergyTradingEscrow.address,tokenAddress:artifact.TestEnergyUSD.address};
}
function context(e){return {matchId:e.match.id,tradeId:e.tradeId,onChainTradeId:e.id,sellerId:e.match.sellerId,buyerId:e.match.buyerId,
 expectedWh:e.terms.quantityWh,deliveryStart:e.trade.deliveryStart,deliveryDeadline:e.trade.deliveryDeadline,escrow:e.escrowAddress,externalTradeId:e.extId};}
function modelPreflight(e){
 const src={deliveryId:'a1b23d45-b234-4a12-8111-111111111111',recordId:'a1b23d45-b234-4a12-8111-111111111111',tradeId:e.tradeId,onChainTradeId:String(e.id),sellerId:e.match.sellerId,buyerId:e.match.buyerId,
   expectedWh:e.terms.quantityWh,deliveredWh:e.terms.quantityWh,timeSlot:new Date(Number(e.trade.deliveryStart)*1000).toISOString(),status:'CONFIRMED',evidenceHash:'0x'+'a'.repeat(64)};
 safeDbProjection(e.rt.deliveryModel,{...src,id:src.deliveryId});
}
function initialChecks(e){
 const result=checkPrerequisites({chain:e.rt.deployed.chainId,trade:e.trade,dbTrade:e.dbTrade,match:e.match,journal:e.journal,
   onChainId:e.id,expectedExternalId:e.extId,oracleHasRole:e.hasRole,escrowPaused:e.rt.deployed.escrowPaused,
   nowSeconds:sec(),escrowBalance:e.escrowBalance});
 requireB16(!e.deliveries.length,'DeliveryRecord already exists before oracle settlement; review existing evidence');
 modelPreflight(e);return result;
}
function display(e,extra={}){
 const w=validateWindow(sec(),e.trade.deliveryStart,e.trade.deliveryDeadline);
 console.log('B16 CHECK: '+JSON.stringify({matchId:e.match.id,chainId:296,tradeId:e.tradeId,onChainTradeId:e.id,
  buyer:e.trade.buyer,seller:e.trade.seller,quantityWh:e.trade.quantityWh,paymentUnits:e.trade.totalAmountMicrousd,
  windowStart:new Date(Number(e.trade.deliveryStart)*1000).toISOString(),windowDeadline:new Date(Number(e.trade.deliveryDeadline)*1000).toISOString(),
  inDeliveryWindow:w.inWindow,oracle:e.oracle,hasOracleRole:e.hasRole,oracleHbarWei:e.oracleHbar.toString(),
  tradeStatus:e.trade.status,dbStatus:e.dbTrade.status,journalStatus:e.intent?.status??'NOT_STAGED',journalTxHash:e.intent?.txHash??null,
  ...extra},null,2));
}
function readRecord(path){
 const raw=readFileSync(resolve(path),'utf8');requireB16(raw.length<16_384,'Evidence file too large');return JSON.parse(raw);
}
function sameIntent(row,p,record){
 requireB16(row&&LOW(row.evidenceHash)===LOW(p.evidenceHash)&&row.onChainTradeId===p.onChainTradeId&&LOW(row.signerAddress)===LOW(p.oracle)&&LOW(row.targetAddress)===LOW(p.escrow)&&row.callDataSha256===sha(p.callData)&&canonical(row.evidencePayload)===canonical(record),'Existing immutable B16 oracle proof differs; never replace');
}
function plan(e,record,now=sec()){
 initialChecks(e);
 const info=validateDelivery(record,context(e),now);
 const evidenceHash=evidenceCommitment(record,context(e));
 const callData=e.interfaces.EnergyTradingEscrow.encodeFunctionData('confirmDelivery',[BigInt(e.id),BigInt(record.deliveredWh),evidenceHash]);
 const p={matchId:e.match.id,tradeId:e.tradeId,onChainTradeId:String(e.id),deliveryId:record.deliveryId,evidenceHash,oracle:LOW(e.oracle),escrow:LOW(e.escrowAddress),callData,
  deliveredWh:info.deliveredWh};
 deliveryDbData(e,record,evidenceHash);
 return p;
}
async function locked(e,fn){
 return e.rt.prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(296, hashtext(${e.match.id}))`;
   const match=await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id"=${e.match.id}::uuid FOR UPDATE`;
   requireB16(match.length===1,'Match disappeared during oracle journal operation');
   const current=await tx.b16OracleIntent.findUnique({where:{matchId:e.match.id}});
   return fn(tx,current);
 },{timeout:45_000,maxWait:10_000});
}
async function stage(e,p,record){
 const row=await locked(e,async(tx,current)=>{
  if(current){sameIntent(current,p,record);return current;}
  return tx.b16OracleIntent.create({data:{matchId:p.matchId,tradeId:p.tradeId,onChainTradeId:p.onChainTradeId,deliveryId:p.deliveryId,
   evidencePayload:record,evidenceHash:p.evidenceHash,signerAddress:p.oracle,targetAddress:p.escrow,callDataSha256:sha(p.callData),status:'PLANNED'}});
 });
 console.log(`B16 STAGED: intent=${row.id} status=${row.status} evidenceHash=${row.evidenceHash}`);return row;
}
function assertSigned(raw,row,p){
 const tx=Transaction.from(raw);
 requireB16(LOW(tx.hash)===LOW(row.txHash)&&LOW(tx.from)===LOW(p.oracle)&&LOW(tx.to)===LOW(p.escrow),'Signed transaction hash or signer/target mismatch');
 requireB16(String(tx.chainId)==='296'&&tx.type===0&&String(tx.nonce)===row.nonce&&LOW(tx.data)===LOW(p.callData)&&tx.value===0n,'Signed transaction chain/nonce/calldata/value mismatch');
 requireB16(tx.gasLimit<=600_000n&&tx.gasLimit*tx.gasPrice<=750_000_000_000_000_000n,'Signed oracle gas beyond cap');
 return tx;
}
async function seal(e,p,row){
 requireB16(row.status==='PLANNED','Only PLANNED evidence may be sealed');
 const {wallet}=addressFromEnv({required:true});requireB16(LOW(wallet.address)===LOW(p.oracle),'Oracle signing key changed');
 const [latest,pending,estimate,fee,balance]=await Promise.all([
  e.provider.getTransactionCount(p.oracle,'latest'),e.provider.getTransactionCount(p.oracle,'pending'),
  e.provider.estimateGas({from:p.oracle,to:p.escrow,data:p.callData,value:0n}),e.provider.getFeeData(),e.provider.getBalance(p.oracle),
 ]);
 requireB16(latest===pending,'Oracle nonce queue has pending transactions');
 const gas=feeQuote({estimate,gasPrice:fee.gasPrice,balance});
 const txRequest={type:0,chainId:296,nonce:latest,to:p.escrow,value:0n,data:p.callData,gasLimit:gas.gasLimit,gasPrice:gas.gasPrice};
 const raw=await wallet.signTransaction(txRequest);const t=Transaction.from(raw);
 requireB16(LOW(t.from)===LOW(p.oracle)&&LOW(t.to)===LOW(p.escrow)&&LOW(t.data)===LOW(p.callData),'Signed transaction differs from exact delivery');
 const saved=await locked(e,async(db,current)=>{
  requireB16(current?.status==='PLANNED','Oracle row changed before sealing');sameIntent(current,p,row.evidencePayload);
  const [n1,n2]=await Promise.all([e.provider.getTransactionCount(p.oracle,'latest'),e.provider.getTransactionCount(p.oracle,'pending')]);
  requireB16(n1===latest&&n2===latest,'Oracle nonce changed before sealing');
  const other=await db.b16OracleIntent.findFirst({where:{signerAddress:p.oracle,status:{in:['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']},NOT:{id:current.id}}});
  requireB16(!other,'Another unresolved oracle intent exists');
  const enc=encryptSignedTransaction(raw,process.env.B14_SIGNED_TX_KEY_B64,current.id);transitions('PLANNED','SIGNED');
  return db.b16OracleIntent.update({where:{id:current.id},data:{status:'SIGNED',nonce:String(latest),txHash:t.hash,
   signedTxCiphertext:enc.ciphertext,signedTxIv:enc.iv,signedTxTag:enc.tag}});
 });
 assertSigned(raw,saved,p);console.log(`B16 SEALED: intent=${saved.id} hash=${saved.txHash}; encrypted; NOT BROADCAST`);return saved;
}
function openSigned(row,p){
 requireB16(row?.signedTxCiphertext&&row.signedTxIv&&row.signedTxTag&&row.txHash,'Signed oracle recovery material missing');
 const raw=decryptSignedTransaction({ciphertext:row.signedTxCiphertext,iv:row.signedTxIv,tag:row.signedTxTag},process.env.B14_SIGNED_TX_KEY_B64,row.id);
 assertSigned(raw,row,p);return raw;
}
async function submit(e,p,row){
 requireB16(row.status==='SIGNED','Only SIGNED oracle intent may submit');
 validateWindow(sec(),e.trade.deliveryStart,e.trade.deliveryDeadline,{fresh:true});
 const raw=openSigned(row,p);
 const [latest,pending,known,receipt]=await Promise.all([
  e.provider.getTransactionCount(p.oracle,'latest'),e.provider.getTransactionCount(p.oracle,'pending'),
  e.provider.getTransaction(row.txHash),e.provider.getTransactionReceipt(row.txHash),
 ]);
 requireB16(latest===Number(row.nonce)&&pending===latest&&!known&&!receipt,'Oracle nonce or network uncertain; do not submit');
 await locked(e,async(db,current)=>{
  requireB16(current?.status==='SIGNED'&&current.txHash===row.txHash,'Oracle journal was changed before broadcast');sameIntent(current,p,row.evidencePayload);
  const [freshLatest,freshPending,found]=await Promise.all([e.provider.getTransactionCount(p.oracle,'latest'),e.provider.getTransactionCount(p.oracle,'pending'),e.provider.getTransactionReceipt(row.txHash)]);
  requireB16(freshLatest===latest&&freshPending===latest&&!found,'Oracle nonce/chain changed before broadcast');
  transitions('SIGNED','SUBMITTED');await db.b16OracleIntent.update({where:{id:row.id},data:{status:'SUBMITTED'}});
 });
 console.log(`B16 SUBMIT CLAIMED: ${row.txHash} status=SUBMITTED; ONE relay attempt follows`);
 try {
  const hash=await e.provider.send('eth_sendRawTransaction',[raw]);requireB16(LOW(hash)===LOW(row.txHash),'Relay hash mismatch');
  console.log(`B16 RELAY ACCEPTED: hash=${hash}; no second submission will be attempted`);
 }catch(err){
  try{await locked(e,async(db,current)=>{
   if(current?.status==='SUBMITTED')await db.b16OracleIntent.update({where:{id:row.id},data:{status:'NEEDS_RECONCILIATION',lastError:'Relay outcome uncertain; reconcile exact hash only'}});
  });}catch{console.error('B16 journal may remain SUBMITTED; inspect it before any further action');}
  throw new Error('Oracle broadcast outcome uncertain; NEVER repeat --execute or resubmit signed bytes. Use --reconcile.');
 }
}
async function inspectSettlement(e,row){
 const record=row.evidencePayload,p={oracle:LOW(row.signerAddress),escrow:LOW(row.targetAddress),callData:e.interfaces.EnergyTradingEscrow.encodeFunctionData('confirmDelivery',[BigInt(row.onChainTradeId),BigInt(record.deliveredWh),row.evidenceHash])};
 requireB16(sha(p.callData)===row.callDataSha256,'Stored oracle calldata fingerprint changed');
 const [receipt,tx]=await Promise.all([e.provider.getTransactionReceipt(row.txHash),e.provider.getTransaction(row.txHash)]);
 const result=receiptResult({row,receipt,transaction:tx,oracle:p.oracle,escrow:p.escrow,calldata:p.callData});
 if(result==='CONFIRMED'){
  const [trade]=await Promise.all([e.rt.reader.getTrade(e.id)]);
  const events=parseKnownReceiptLogs(receipt,e.rt.artifact,e.interfaces);
  verifySettlement({events,trade,proof:{deliveredWh:record.deliveredWh,evidenceHash:row.evidenceHash},onChainId:e.id,
   seller:e.terms.seller,escrow:e.escrowAddress,token:e.tokenAddress,amount:e.terms.totalAmountMicrousd});
 }
 return result;
}
async function reconcile(e){
 const row=e.intent;requireB16(row,'No B16 oracle journal to reconcile');
 requireB16(row.status!=='PLANNED'&&row.status!=='SIGNED','Oracle transaction was not broadcast; do not reconcile');
 requireB16(row.status!=='REVERTED','Oracle transaction reverted; investigate');
 if(row.status==='CONFIRMED'){await inspectSettlement(e,row);console.log(`B16 ALREADY CONFIRMED: ${row.txHash}`);return 'CONFIRMED';}
 const proof={oracle:LOW(row.signerAddress),escrow:LOW(row.targetAddress),callData:e.interfaces.EnergyTradingEscrow.encodeFunctionData('confirmDelivery',[BigInt(row.onChainTradeId),BigInt(row.evidencePayload.deliveredWh),row.evidenceHash])};
 openSigned(row,proof);
 const result=await inspectSettlement(e,row);
 if(row.status==='SIGNED'&&result==='UNKNOWN')throw new Error('SIGNED oracle transaction has not appeared on-chain. Do not resubmit without independent nonce review.');
 let next=result==='CONFIRMED'?'CONFIRMED':result==='REVERTED'?'REVERTED':result==='UNKNOWN'?'NEEDS_RECONCILIATION':row.status;
 const saved=await locked(e,async(db,current)=>{
   requireB16(current?.txHash===row.txHash,'Oracle journal transaction hash changed');
   if(current.status===next)return current;
   transitions(current.status,next);
   return db.b16OracleIntent.update({where:{id:row.id},data:{status:next,...(next==='CONFIRMED'?{confirmedAt:new Date(),lastError:null}:{}),...(next==='NEEDS_RECONCILIATION'?{lastError:'Receipt not indexed; never resubmit'}:{})}});
 });
 console.log(`B16 RECONCILED: ${row.status}->${saved.status} txHash=${row.txHash}; no new transaction`);
 return saved.status;
}
async function syncDb(e){
 const row=await e.rt.prisma.b16OracleIntent.findUnique({where:{matchId:e.match.id}});
 requireB16(row?.status==='CONFIRMED'&&row.confirmedAt,'Oracle journal must have successful receipt reconciliation');
 requireB16((await inspectSettlement(e,row))==='CONFIRMED','Current chain and oracle receipt are not confirmed');
 const record=row.evidencePayload;
 const projection=deliveryDbData(e,record,row.evidenceHash);
 await locked(e,async(db,current)=>{
  requireB16(current?.status==='CONFIRMED'&&current.txHash===row.txHash,'B16 journal is not finalized');
  const trade=await db.trade.findUnique({where:{matchId:e.match.id}});
  requireB16(['AWAITING_DELIVERY','COMPLETED'].includes(trade?.status),'Trade status cannot be safely promoted');
  requireB16(String(trade.onChainTradeId)===String(row.onChainTradeId),'DB Trade ID changed');
  const existing=await db.deliveryRecord.findMany({where:{tradeId:e.tradeId}});
  requireB16(existing.length<=1,'Multiple delivery records already exist; manual review needed');
  if(existing.length===1){
   for(const [k,v] of Object.entries(projection)){
    const observed=existing[0][k];const normalize=x=>x instanceof Date?x.getTime():typeof x==='bigint'?x.toString():String(x).toLowerCase();
    requireB16(normalize(observed)===normalize(v),`Existing DeliveryRecord.${k} conflicts with oracle proof`);
   }
  } else await db.deliveryRecord.create({data:projection});
  if(trade.status==='AWAITING_DELIVERY')await db.trade.update({where:{matchId:e.match.id},data:{status:'COMPLETED'}});
  if(!current.syncedAt)await db.b16OracleIntent.update({where:{id:current.id},data:{syncedAt:new Date()}});
 });
 console.log(`B16 DATABASE SYNC PASS: Trade COMPLETED, DeliveryRecord CONFIRMED, hash=${row.evidenceHash}`);
}
async function verifyAll(e){
 const row=e.intent??await e.rt.prisma.b16OracleIntent.findUnique({where:{matchId:e.match.id}});
 requireB16(row?.status==='CONFIRMED'&&row.syncedAt,'B16 journal not fully reconciled/synced');
 requireB16((await inspectSettlement(e,row))==='CONFIRMED','Confirmed receipt or on-chain proof missing');
 const [trade,deliveries]=await Promise.all([e.rt.prisma.trade.findUnique({where:{matchId:e.match.id}}),e.rt.prisma.deliveryRecord.findMany({where:{tradeId:e.tradeId}})]);
 requireB16(trade?.status==='COMPLETED'&&deliveries.length===1,'Trade/DeliveryRecord not consistent in PostgreSQL');
 const expected=deliveryDbData(e,row.evidencePayload,row.evidenceHash);
 for(const [k,v] of Object.entries(expected)){
  const normalize=x=>x instanceof Date?x.getTime():typeof x==='bigint'?x.toString():String(x).toLowerCase();
  requireB16(normalize(deliveries[0][k])===normalize(v),`DeliveryRecord.${k} is not verified`);
 }
 console.log(`B16 VERIFY PASS: trade ${e.id} COMPLETED; DeliveryConfirmed + TradeSettled + seller TEUSD Transfer; PostgreSQL Trade & DeliveryRecord consistent; no writes`);
}
async function simulate(e,args){
 initialChecks(e);
 const sim=simulationPlan(sec(),e.trade.deliveryStart,e.trade.deliveryDeadline);
 requireB16(!e.intent,'B16 journal already exists; never replace oracle evidence');
 const qty=Number(args.deliveredWh??e.terms.quantityWh);
 requireB16(Number.isSafeInteger(qty)&&qty>=Number(e.terms.quantityWh)&&qty<=Number(e.terms.quantityWh)*1.1,'Simulated delivery quantity must be within 100%-110%');
 const output=resolve(args.output);requireB16(!existsSync(output),'Evidence output already exists; never overwrite');
 const dryRun=sim.mode==='ISOLATED_DRY_RUN';
 // Isolated mode uses deliberately unrelated IDs and a synthetic active window.
 // Its output is temporary and is deleted, never passed to execute().
 const trade={tradeId:dryRun?randomUUID():e.tradeId,onChainTradeId:dryRun?999999999:Number(e.id),
  sellerId:dryRun?randomUUID():e.match.sellerId,buyerId:dryRun?randomUUID():e.match.buyerId,
  expectedWh:Number(e.terms.quantityWh),deliveryStart:new Date(Number(sim.start)*1000).toISOString().replace('.000Z','Z'),
  deliveryDeadline:new Date(Number(sim.deadline)*1000).toISOString().replace('.000Z','Z'),status:'AWAITING_DELIVERY'};
 const config={scenario:'SUCCESS',deliveredWh:qty,reportedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
 const temp=mkdtempSync(join(tmpdir(),'b16-sim-'));
 try{
  const destination=dryRun?join(temp,'preview-only-delivery.json'):output;
  writeFileSync(join(temp,'trade.json'),JSON.stringify(trade));writeFileSync(join(temp,'config.json'),JSON.stringify(config));
  const python=selectB16Python(ROOT);
  const result=spawnSync(python,['-m','data_generator.cli','generate-delivery','--input',join(temp,'trade.json'),'--config',join(temp,'config.json'),'--output',destination],
   {cwd:join(ROOT,'services/data-generator'),encoding:'utf8',env:b16PythonEnv(ROOT),timeout:30_000,maxBuffer:128*1024});
  if(result.error||result.status!==0)throw new Error(b16PythonFailure(result,python));
  requireB16(existsSync(destination),'Python simulator did not create the expected evidence output');
  const record=readRecord(destination);
  if(dryRun){
   // Check the actual Python output against its own isolated test context,
   // not against the real future-funded trade. Never create a portable proof.
   const sampleContext={...context(e),tradeId:trade.tradeId,onChainTradeId:String(trade.onChainTradeId),
     sellerId:trade.sellerId,buyerId:trade.buyerId,deliveryStart:sim.start,deliveryDeadline:sim.deadline};
   validateDelivery(record,sampleContext,sec());
   requireB16(!existsSync(output),'Isolated dry run must not create the real-trade evidence file');
   console.log('B16 SIMULATOR DRY RUN PASS: Python generated and validated isolated synthetic delivery');
   console.log('B16 DRY RUN SAFE: no actual-trade evidence file, journal write, signature, or Hedera transaction');
   console.log(`B16 REAL DELIVERY WINDOW: ${new Date(Number(e.trade.deliveryStart)*1000).toISOString()} to ${new Date(Number(e.trade.deliveryDeadline)*1000).toISOString()}`);
  }else{
   const proof=plan(e,record);
   console.log(`B16 SIMULATED EVIDENCE: ${output}`);
   console.log(`B16 PROOF HASH: ${proof.evidenceHash}`);
   console.log('B16 SIMULATION PASS: existing Python generator used; no PostgreSQL write, signing or Hedera transaction');
  }
 }finally{rmSync(temp,{recursive:true,force:true});}
}

async function execute(e,args){
 requireB16(process.env.B16_SETTLEMENT_CONFIRM==='I_AUTHORIZE_ONE_ORACLE_SETTLEMENT_ON_HEDERA_TESTNET','Explicit oracle settlement authorization required');
 const record=readRecord(args.evidence);const p=plan(e,record);
 display(e,{evidenceHash:p.evidenceHash,action:'EXECUTE_SIGN_AND_SEND_ONCE'});
 let row=await stage(e,p,record);
 if(row.status==='CONFIRMED'){console.log('Oracle already confirmed; only database sync allowed');await syncDb(e);return;}
 requireB16(['PLANNED','SIGNED'].includes(row.status),'B16 already submitted or uncertain; use --reconcile only');
 if(row.status==='PLANNED')row=await seal(e,p,row);
 await submit(e,p,row);
 // Read once; do not automatically retry an on-chain write after any uncertainty.
 const fresh=await load(e.rt,e.match.id);const status=await reconcile(fresh);
 if(status!=='CONFIRMED')throw new Error('Oracle submitted but receipt not confirmed; run --reconcile with the SAME hash later. No second submission.');
 const confirmed=await load(e.rt,e.match.id);await syncDb(confirmed);await verifyAll(await load(e.rt,e.match.id));
}
async function main(){
 const args=argsB16(process.argv.slice(2));
 if(args.action==='execute')requireB16(process.env.B16_SETTLEMENT_CONFIRM==='I_AUTHORIZE_ONE_ORACLE_SETTLEMENT_ON_HEDERA_TESTNET','Explicit B16 settlement consent required');
 const rt=await runtime();
 try{
  const e=await load(rt,args.matchId);
  if(args.action==='preflight'){
   const check=e.trade.status==='AWAITING_DELIVERY'?initialChecks(e):null;
   display(e,{action:'PREFLIGHT_READ_ONLY',eligibleInWindow:check?.inWindow??false});
   console.log('B16 PREFLIGHT PASS: current contracts, oracle role, B15 trade and schema checked; no writes');
  }else if(args.action==='simulate')await simulate(e,args);
  else if(args.action==='execute')await execute(e,args);
  else if(args.action==='reconcile'){display(e,{action:'RECONCILE_EXISTING_HASH_ONLY'});await reconcile(e);}
  else if(args.action==='sync'){requireB16(process.env.B16_DB_SYNC_CONFIRM==='SYNC_CONFIRMED_B16_DELIVERY_ONLY','B16 DB sync consent required');await syncDb(e);}
  else if(args.action==='verify'){display(e,{action:'VERIFY_READ_ONLY'});await verifyAll(e);}
 }finally{rt.reader.close();await rt.prisma.$disconnect();}
}
main().catch(err=>{console.error('B16 STOP: '+redact(err));console.error('No replacement oracle key, evidence, transaction, or manual journal mutation. If submitted, reconcile the SAME hash.');process.exitCode=1;});
