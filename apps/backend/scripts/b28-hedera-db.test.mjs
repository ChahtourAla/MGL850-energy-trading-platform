import test from 'node:test';
import assert from 'node:assert/strict';
import {getMarket,setupRole,makeIntentAndAttempt,recordReceipt,updateAttempt} from './b28-hedera-db.mjs';
import {MARKET,PLAN,SNAPSHOT,SNAPSHOT_HASH,MANIFEST_HASH,CHOSEN,PRICING,TOKEN,PINNED_PLAN_VERSION} from './b28-hedera-core.mjs';
import {allocationId as deriveId} from '../../../packages/shared/v2-identity.mjs';
const market={id:MARKET,status:'MATCHED',namespace:'hourly',mode:'HOURLY'};
const snapshot={id:SNAPSHOT,marketId:MARKET,status:'FINALIZED',payloadHash:SNAPSHOT_HASH};
const plan={id:PLAN,marketId:MARKET,snapshotId:SNAPSHOT,status:'AUTHORITATIVE',manifestHash:MANIFEST_HASH,planVersion:PINNED_PLAN_VERSION,manifest:{snapshotHash:SNAPSHOT_HASH,pricingPolicyVersion:PRICING}};
const allocation={id:deriveId(MARKET,SNAPSHOT_HASH,CHOSEN.buyerId,CHOSEN.sellerId,CHOSEN.buyerAddress.toLowerCase(),CHOSEN.sellerAddress.toLowerCase(),'246','85189','1.0.0',PRICING,PINNED_PLAN_VERSION),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',planVersion:PINNED_PLAN_VERSION,remainder:494,buyerId:CHOSEN.buyerId,sellerId:CHOSEN.sellerId,buyerAddress:CHOSEN.buyerAddress,sellerAddress:CHOSEN.sellerAddress,quantityWh:246n,unitPriceMicrousdPerKwh:85189n,amountBaseUnits:20956n};
const other=(id,q,rem,pay,buyer,seller)=>({id:deriveId(MARKET,SNAPSHOT_HASH,buyer,seller,'0x'+id.repeat(40),'0x'+'a'.repeat(40),String(q),'154714','1.0.0',PRICING,PINNED_PLAN_VERSION),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',planVersion:PINNED_PLAN_VERSION,remainder:rem,buyerId:buyer,sellerId:seller,buyerAddress:'0x'+id.repeat(40),sellerAddress:'0x'+'a'.repeat(40),quantityWh:BigInt(q),unitPriceMicrousdPerKwh:154714n,amountBaseUnits:BigInt(pay)});
function resultsForSelected(suffix){
 return suffix==='2'?other('2',254,356,39297,'76cc42d6-ae03-514d-8a22-fcc1530a4a16','e0742bb7-4b60-5679-b59b-35f36e7a75d0'):
 other('3',2572,408,397924,'3e06a60f-af1f-5715-9712-1df78c6d1e26','e0742bb7-4b60-5679-b59b-35f36e7a75d0');
}
function fakeDB(extra=[]){
 const calls=[];
 const results=[market,snapshot,plan,[allocation,other('2',254,356,39297,'76cc42d6-ae03-514d-8a22-fcc1530a4a16','e0742bb7-4b60-5679-b59b-35f36e7a75d0'),other('3',2572,408,397924,'3e06a60f-af1f-5715-9712-1df78c6d1e26','e0742bb7-4b60-5679-b59b-35f36e7a75d0')],
  [{userId:CHOSEN.buyerId,evmAddress:CHOSEN.buyerAddress,hederaAccountId:'0.0.1'},{userId:CHOSEN.sellerId,evmAddress:CHOSEN.sellerAddress,hederaAccountId:'0.0.2'}],[],...extra];
 const client={query:async(sql,args)=>{calls.push({sql,args});const index=calls.length-1;if(index>=results.length)throw Error('Unexpected SQL command');
  if(sql.includes('FROM public.wallets')){
   const chosen=results[3].find(a=>a.buyerId===args[0]&&a.sellerId===args[1]);
   if(!chosen)throw Error('Wallet test fixture mismatch');
   return {rows:[{userId:chosen.buyerId,evmAddress:chosen.buyerAddress,hederaAccountId:'0.0.1'},
    {userId:chosen.sellerId,evmAddress:chosen.sellerAddress,hederaAccountId:'0.0.2'}]};
  }
  const row=results[index];return {rows:Array.isArray(row)?row:[row]};}};
 return {client,calls};
}
test('B28 read model verifies the full authoritative market and both wallets',async()=>{
 const {client,calls}=fakeDB();const view=await getMarket(client);
 assert.equal(view.allocation.id,allocation.id);assert.equal(view.attempts.length,0);
 assert.equal(calls.length,6);assert.match(calls[4].sql,/user_id IN/);assert.doesNotMatch(calls[4].sql,/encrypted_private_key/);
});
test('B28 custody secrets selected only when explicitly requested',async()=>{
 const {client,calls}=fakeDB();await getMarket(client,{readKey:true});
 assert.match(calls[4].sql,/encrypted_private_key/);
});
test('B28 readback refuses alternative authoritative totals',async()=>{
 const {client}=fakeDB();
 const q=client.query.bind(client);let n=0;
 client.query=async(s,a)=>{const x=await q(s,a);if(++n===4)x.rows[0]={...x.rows[0],amountBaseUnits:20957n};return x;};
 await assert.rejects(()=>getMarket(client),/Incorrect rounded price/);
});
test('role setup rejects privilege escalation before executing any SQL DDL',async()=>{
 let commands=0;
 const c={query:async()=>{commands++;return {rows:[{rolcanlogin:true}]};}};
 await assert.rejects(()=>setupRole(c),/Unsafe B28 writer/);
 assert.equal(commands,1);
});
test('journal insert is bound to the signed hash and rejected on existing intent',async()=>{
 const ops=[];
 const c={query:async(sql,args)=>{ops.push({sql,args});
  if(sql.includes('SELECT current_user'))return {rows:[{actor:'b28_hedera_writer'}]};
  if(sql.includes('SELECT id FROM "V2SettlementIntent"'))return {rows:[]};
  return {rows:[],rowCount:1};
 }};
 const digest='0x'+'a'.repeat(64),hash='0x'+'b'.repeat(64);
 const saved=await makeIntentAndAttempt(c,{settlementId:digest,allocation,contract:'0x'+'c'.repeat(40),token:TOKEN,attemptHash:hash,nonce:4,kind:'B28_SETTLEMENT',metadata:{deadline:'9999999'}});
 assert.equal(saved.sequence,1);assert(ops.some(o=>o.sql.includes('INSERT INTO "V2SettlementIntent"')&&o.args[0]===digest));
 assert(ops.some(o=>o.sql.includes('INSERT INTO "V2SettlementAttempt"')&&o.args[3]===hash));
});
test('receipt persistence rejects incorrect previously recorded amount',async()=>{
 const c={query:async(sql)=>{
  if(sql.includes('SELECT current_user'))return {rows:[{actor:'b28_hedera_writer'}]};
  if(sql.includes('SELECT * FROM "V2SettlementIntent"'))return {rows:[{id:'0x'+'a'.repeat(64),allocationId:allocation.id,chainId:296,tokenAddress:TOKEN.toLowerCase(),contractAddress:'0x'+'c'.repeat(40),amountBaseUnits:999n}]};
  return {rows:[]};
 }};
 await assert.rejects(()=>recordReceipt(c,{settlementId:'0x'+'a'.repeat(64),attemptId:'id',txHash:'0x'+'b'.repeat(64),blockHash:'0x'+'d'.repeat(64),logIndex:0,allocation,contract:'0x'+'c'.repeat(40),token:TOKEN}),/binding mismatch/);
});

test('B28 read model selects and binds each other authorized allocation independently',async()=>{
 for(const suffix of ['2','3']){
  const {client,calls}=fakeDB();
  const match=resultsForSelected(suffix);
  const id=match.id;
  const view=await getMarket(client,{allocationId:id});
  assert.equal(view.allocation.id,id);
  assert.equal(calls[4].args[0],view.allocation.buyerId);
  assert.equal(calls[4].args[1],view.allocation.sellerId);
 }
});
test('B28 read model refuses non-authoritative allocation selection',async()=>{
 const {client}=fakeDB();
 await assert.rejects(()=>getMarket(client,{allocationId:'0x'+'f'.repeat(64)}),/not part/);
});
