/** B28 Hedera Testnet settlement database journal. No B24/B25 modifications. */
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MARKET,PLAN,CHOSEN,assertPinnedMarket} from './b28-hedera-core.mjs';
const roleSql = fileURLToPath(new URL('../../../database/ops/B28_SETTLEMENT_ROLE.sql',import.meta.url));
const ACTOR='energy_admin', DB='energy_trading';
const validHash=/^0x[a-f0-9]{64}$/;
export async function connect() {
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL missing');
 let endpoint;try{endpoint=new URL(process.env.DATABASE_URL);}catch{throw Error('Invalid DATABASE_URL format');}
 if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/energy_trading'||decodeURIComponent(endpoint.username)!=='energy_admin'||endpoint.hash||endpoint.searchParams.size>1||(endpoint.searchParams.size===1&&endpoint.searchParams.get('schema')!=='public'))throw Error('Refusing non-local or non-approved B28 PostgreSQL target');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:15000,statement_timeout:12000,application_name:'mgl850-b28-hedera'});
 await client.connect();
 try{
  const q=await client.query('SELECT current_database() db,session_user actor,inet_server_addr() AS server_addr');
  if(q.rows[0]?.db!==DB||q.rows[0]?.actor!==ACTOR)throw Error('Refusing non-approved persistent database and role');
  return client;
 } catch(e){await client.end().catch(()=>{});throw e;}
}
export async function getMarket(c,{readKey=false,allocationId=null}={}){
 const one=async(sql,args)=>{const x=await c.query(sql,args);if(x.rows.length!==1)throw Error('Missing or conflicting B28.1 authoritative data');return x.rows[0];};
 const [market,snapshot,plan,allocRows]=await (async()=>{
  const m=await one('SELECT * FROM "V2Market" WHERE id=$1',[MARKET]);
  const s=await one('SELECT * FROM "V2Snapshot" WHERE "marketId"=$1',[MARKET]);
  const p=await one('SELECT * FROM "V2AllocationPlan" WHERE "marketId"=$1',[MARKET]);
  const a=(await c.query('SELECT * FROM "V2Allocation" WHERE "marketId"=$1 ORDER BY id',[MARKET])).rows;
  return [m,s,p,a];
 })();
 const selected=assertPinnedMarket(market,snapshot,plan,allocRows,allocationId);
 const {rows:wallets}=await c.query('SELECT user_id AS "userId",evm_address AS "evmAddress",hedera_account_id AS "hederaAccountId"'+(readKey?',public_key AS "publicKey",encrypted_private_key AS "encryptedPrivateKey",encryption_iv AS "encryptionIv",encryption_auth_tag AS "encryptionAuthTag",key_version AS "keyVersion"':'')+' FROM public.wallets WHERE user_id IN ($1,$2)',[selected.buyerId,selected.sellerId]);
 if(wallets.length!==2)throw Error('Buyer or seller has no provisioned wallet');
 const b=wallets.find(w=>w.userId===selected.buyerId),s=wallets.find(w=>w.userId===selected.sellerId);
 if(!b||!s||b.evmAddress.toLowerCase()!==selected.buyerAddress.toLowerCase()||s.evmAddress.toLowerCase()!==selected.sellerAddress.toLowerCase())throw Error('B28 wallet identity mismatch');
 const intent=(await c.query('SELECT * FROM "V2SettlementIntent" WHERE "allocationId"=$1',[selected.id])).rows;
 const attempts=intent.length?(await c.query('SELECT * FROM "V2SettlementAttempt" WHERE "settlementId"=$1 ORDER BY sequence',[intent[0].id])).rows:[];
 const evidence=intent.length?(await c.query('SELECT * FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[intent[0].id])).rows:[];
 return {market,snapshot,plan,allocations:allocRows,allocation:selected,buyerWallet:b,sellerWallet:s,intent:intent[0]??null,attempts,evidence};
}
export async function setupRole(c){
 const {rows:prior}=await c.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='b28_hedera_writer'");
 if(prior.some(x=>x.rolcanlogin||x.rolsuper||x.rolcreatedb||x.rolcreaterole||x.rolbypassrls))throw Error('Unsafe B28 writer role exists');
 const sql=await readFile(roleSql,'utf8');
 await c.query('BEGIN');
 try{
  await c.query('SET LOCAL lock_timeout = \'5s\'');
  await c.query(sql);
  const {rows:roles}=await c.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='b28_hedera_writer'");
  if(roles.length!==1||roles[0].rolcanlogin||roles[0].rolsuper||roles[0].rolcreatedb||roles[0].rolcreaterole||roles[0].rolbypassrls)throw Error('Invalid restricted writer role after setup');
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function restrictedWrite(c,fn){
 await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 try{
  await c.query("SET LOCAL lock_timeout='5s'");
  await c.query("SET LOCAL statement_timeout='12s'");
  await c.query('SET LOCAL ROLE b28_hedera_writer');
  const {rows:[id]}=await c.query('SELECT current_user actor');
  if(id.actor!=='b28_hedera_writer')throw Error('Restricted settlement writer role missing');
  const value=await fn(c);
  await c.query('COMMIT');
  return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function makeIntentAndAttempt(c,{settlementId,allocation,contract,token,attemptHash,nonce,kind,metadata}){
 if(!validHash.test(settlementId)||!validHash.test(attemptHash)||!['B28_APPROVAL','B28_SETTLEMENT'].includes(kind))throw Error('Invalid transaction journal');
 return restrictedWrite(c,async t=>{
  const found=(await t.query('SELECT id FROM "V2SettlementIntent" WHERE "allocationId"=$1',[allocation.id])).rows;
  if(found.length)throw Error('Existing settlement: never resubmit; reconcile');
  await t.query('INSERT INTO "V2SettlementIntent" (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt") VALUES ($1,$2,$3,296,$4,$5,$6,$7,now())',[settlementId,allocation.id,MARKET,token.toLowerCase(),contract.toLowerCase(),allocation.amountBaseUnits,'PLANNED']);
  const id=randomUUID();
  await t.query('INSERT INTO "V2SettlementAttempt" (id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"recoveryMetadata","updatedAt") VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,now())',[id,settlementId,'SIGNED',attemptHash,kind,nonce,JSON.stringify(metadata)]);
  return {id,sequence:1};
 });
}
export async function addAttempt(c,{settlementId,txHash,nonce,metadata}){
 if(!validHash.test(txHash))throw Error('Invalid settlement transaction hash');
 return restrictedWrite(c,async t=>{
  const {rows:intents}=await t.query('SELECT * FROM "V2SettlementIntent" WHERE id=$1 FOR UPDATE',[settlementId]);
  if(intents.length!==1||intents[0].status!=='READY')throw Error('Not ready for operator execution');
  const {rows:attempts}=await t.query('SELECT sequence,status,"transactionIdentity" FROM "V2SettlementAttempt" WHERE "settlementId"=$1',[settlementId]);
  if(attempts.some(a=>a.transactionIdentity==='B28_SETTLEMENT'))throw Error('Settlement attempt already exists; reconcile');
  if(attempts.length!==1||attempts[0].transactionIdentity!=='B28_APPROVAL'||attempts[0].status!=='CONFIRMED')throw Error('Approval attempt is not confirmed');
  const id=randomUUID();
  await t.query('INSERT INTO "V2SettlementAttempt" (id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"recoveryMetadata","updatedAt") VALUES ($1,$2,2,$3,$4,$5,$6,$7::jsonb,now())',[id,settlementId,'SIGNED',txHash,'B28_SETTLEMENT',nonce,JSON.stringify(metadata)]);
  return {id,sequence:2};
 });
}
export async function updateAttempt(c,{id,status,intentStatus}) {
 if(!['SUBMITTED','CONFIRMED','NEEDS_RECONCILIATION'].includes(status))throw Error('Invalid journal status');
 await restrictedWrite(c,async t=>{
  const {rows:[a]}=await t.query('SELECT * FROM "V2SettlementAttempt" WHERE id=$1 FOR UPDATE',[id]);
  if(!a||!['SIGNED','SUBMITTED','NEEDS_RECONCILIATION'].includes(a.status))throw Error('Unacceptable journal transition');
  await t.query('UPDATE "V2SettlementAttempt" SET status=$1,"updatedAt"=now() WHERE id=$2',[status,id]);
  if(intentStatus){
   if(!['READY','SUBMITTED','UNKNOWN'].includes(intentStatus))throw Error('Invalid intent state');
   await t.query('UPDATE "V2SettlementIntent" SET status=$1,"updatedAt"=now() WHERE id=$2',[intentStatus,a.settlementId]);
  }
 });
}
export async function recordReceipt(c,{settlementId,attemptId,txHash,blockHash,logIndex,allocation,contract,token}) {
 return restrictedWrite(c,async t=>{
  const {rows:[intent]}=await t.query('SELECT * FROM "V2SettlementIntent" WHERE id=$1 FOR UPDATE',[settlementId]);
  if(!intent||intent.allocationId!==allocation.id||intent.chainId!==296||intent.tokenAddress!==token.toLowerCase()||intent.contractAddress!==contract.toLowerCase()||BigInt(intent.amountBaseUnits)!==BigInt(allocation.amountBaseUnits))throw Error('Intent evidence binding mismatch');
  const {rows:[a]}=await t.query('SELECT * FROM "V2SettlementAttempt" WHERE id=$1 AND "settlementId"=$2 FOR UPDATE',[attemptId,settlementId]);
  if(!a||a.transactionIdentity!=='B28_SETTLEMENT'||a.txHash!==txHash||!['SIGNED','SUBMITTED','NEEDS_RECONCILIATION'].includes(a.status))throw Error('Settlement attempt mismatch');
  const prev=(await t.query('SELECT id FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[settlementId])).rows;
  if(prev.length)throw Error('Existing evidence requires independent audit; not overwriting');
  await t.query('INSERT INTO "V2SettlementEvidence" (id,"settlementId","chainId","contractAddress","tokenAddress","txHash","blockReference","receiptStatus","logIndex","buyerAddress","sellerAddress","amountBaseUnits","confirmedAt","verificationStatus") VALUES ($1,$2,296,$3,$4,$5,$6,\'SUCCESS\',$7,$8,$9,$10,now(),\'VERIFIED\')',[randomUUID(),settlementId,contract.toLowerCase(),token.toLowerCase(),txHash,blockHash,logIndex,allocation.buyerAddress.toLowerCase(),allocation.sellerAddress.toLowerCase(),allocation.amountBaseUnits]);
  await t.query('UPDATE "V2SettlementAttempt" SET status=\'CONFIRMED\',"updatedAt"=now() WHERE id=$1',[attemptId]);
  await t.query('UPDATE "V2SettlementIntent" SET status=\'CONFIRMED\',"updatedAt"=now() WHERE id=$1',[settlementId]);
 });
}
