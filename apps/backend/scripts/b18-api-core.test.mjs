import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUuid, parsePage, hasParticipant, checkTradeSource, valueToWire,
  publicMatch, publicTrade, publicDelivery, publicIntent, paginate,
  verifyOnChainLink, parsePreflightBody, previewOperation,
} from './b18-api-core.mjs';
const BUYER='11111111-1111-4111-8111-111111111111';
const SELLER='22222222-2222-4222-8222-222222222222';
const OTHER='33333333-3333-4333-8333-333333333333';
const MID='44444444-4444-4444-8444-444444444444';
const TID='55555555-5555-4555-8555-555555555555';
const match={id:MID,buyerId:BUYER,sellerId:SELLER,quantityWh:2188n,timeSlot:new Date('2026-11-09T12:00:00Z'),status:'SELECTED',passwordHash:'SECRET'};
const trade={id:TID,matchId:MID,buyerId:BUYER,sellerId:SELLER,onChainTradeId:'2',externalTradeId:'0x'+'1'.repeat(64),
 buyerWallet:'0x'+'a'.repeat(40),sellerWallet:'0x'+'b'.repeat(40),quantityWh:2188n,
 unitPriceMicrousdPerKwh:114366n,totalAmountMicrousd:250232n,status:'AWAITING_DELIVERY',
 signedTxCiphertext:'PRIVATE',privateKey:'NEVER',signedTxIv:'SECRET'};
const chain={onChainTradeId:'2',externalTradeId:trade.externalTradeId,buyer:trade.buyerWallet,seller:trade.sellerWallet,
 quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:'250232',
 status:'AWAITING_DELIVERY',deliveredWh:'0',evidenceHash:'0x'+'0'.repeat(64),deliveryStart:'1794366000',deliveryDeadline:'1794369600'};

for(const id of [BUYER,SELLER,OTHER,MID,TID])test('valid UUID '+id,()=>assert.equal(assertUuid(id),id));
for(const id of ['',null,{},'abc','x'.repeat(36),'11111111-1111-1111-1111-111111111111','123e4567-e89b-12d3-a456-42661417400x']){
  test('reject malformed UUID '+String(id),()=>assert.throws(()=>assertUuid(id)));
}
for(const [val,expected] of [['1',1],['20',20],['50',50], [undefined,20]]) {
  test(`pagination accepts ${String(val)}`,()=>assert.equal(parsePage(val).limit,expected));
}
for(const invalid of ['0','51','1000','-1','1e2',' 2 ','2.1',2,null,[],{}]) {
  test('pagination rejects '+String(invalid),()=>assert.throws(()=>parsePage(invalid)));
}
test('cursor optional and validated',()=>{
  assert.equal(parsePage('4',MID).cursor,MID);
  assert.throws(()=>parsePage('4','INVALID'));
});
test('buyer can see match',()=>assert.ok(hasParticipant(match,BUYER)));
test('seller can see match',()=>assert.ok(hasParticipant(match,SELLER)));
test('unrelated user cannot see match',()=>assert.equal(hasParticipant(match,OTHER),false));
test('missing user cannot see match',()=>assert.equal(hasParticipant(match,''),false));
test('missing match cannot authorize',()=>assert.equal(hasParticipant(null,BUYER),false));
test('trade references source correctly',()=>assert.ok(checkTradeSource(trade,match)));
for(const change of [{buyerId:OTHER},{sellerId:OTHER},{matchId:OTHER}]){
  test('trade source conflict '+Object.keys(change)[0],()=>assert.throws(()=>checkTradeSource({...trade,...change},match)));
}
test('BigInt -> exact decimal string',()=>assert.equal(valueToWire(999999999999999999n),'999999999999999999'));
test('Date -> UTC',()=>assert.equal(valueToWire(new Date('2026-11-11T03:00:00Z')),'2026-11-11T03:00:00.000Z'));
test('decimal-like object -> string',()=>assert.equal(valueToWire({constructor:{name:'Decimal'},toString:()=> '0.123456'}),'0.123456'));
test('reject unknown objects',()=>assert.throws(()=>valueToWire({private:'data'})));
test('reject Infinity',()=>assert.throws(()=>valueToWire(Infinity)));
test('match projection whitelist excludes secrets',()=>{
  const r=publicMatch(match);assert.equal(r.quantityWh,'2188');
  assert.equal(r.timeSlot,'2026-11-09T12:00:00.000Z');
  assert.equal(r.passwordHash,undefined);
});
test('trade projection whitelist excludes encrypted signing material',()=>{
  const r=publicTrade(trade);assert.equal(r.totalAmountMicrousd,'250232');
  for(const k of ['privateKey','signedTxCiphertext','signedTxIv']) assert.equal(r[k],undefined);
});
test('delivery projection excludes evidence payload',()=>{
  const r=publicDelivery({id:TID,tradeId:TID,status:'CONFIRMED',evidenceHash:'0x123',evidencePayload:{secret:'bad'}});
  assert.equal(r.evidenceHash,'0x123');assert.equal(r.evidencePayload,undefined);
});
test('journal projection excludes raw encrypted transaction',()=>{
  const r=publicIntent({operation:'FUND_TRADE',status:'CONFIRMED',txHash:'0x123',signedTxCiphertext:'ENCRYPTED',nonce:'1',lastError:'secret'},'B14');
  assert.equal(r.phase,'B14');assert.equal(r.operation,'FUND_TRADE');assert.equal(r.signedTxCiphertext,undefined);
  assert.equal(r.nonce,undefined);assert.equal(r.lastError,undefined);
});
test('pagination stable last included ID',()=>{
  const a=[{id:BUYER},{id:SELLER},{id:OTHER}];const r=paginate(a,2,x=>({id:x.id}));
  assert.equal(r.items.length,2);assert.equal(r.nextCursor,SELLER);
});
test('pagination final page null cursor',()=>assert.equal(paginate([{id:BUYER}],10,x=>({id:x.id})).nextCursor,null));
test('pagination invalid page refuses',()=>assert.throws(()=>paginate([],60,()=>({}))));
test('onchain identity and amount validated',()=>{
  const r=verifyOnChainLink(trade,chain);assert.equal(r.chainId,296);assert.equal(r.statusAligned,true);assert.equal(r.totalAmountMicrousd,'250232');
});
for(const bad of [
  {onChainTradeId:'3'},{externalTradeId:'0x'+'2'.repeat(64)},
  {quantityWh:'2100'},{unitPriceMicrousdPerKwh:'100'},{totalAmountMicrousd:'1'},
  {buyer:'0x'+'c'.repeat(40)},{seller:'0x'+'c'.repeat(40)}]){
  test('onchain mismatch blocked '+Object.keys(bad)[0],()=>assert.throws(()=>verifyOnChainLink(trade,{...chain,...bad})));
}
test('status mismatch exposed but not silently coerced',()=>{
  const r=verifyOnChainLink(trade,{...chain,status:'COMPLETED'});
  assert.equal(r.statusAligned,false);
});
for(const op of ['CANCEL','EXPIRE','REFUND','ORACLE_CONFIRM','DB_RECONCILE']){
  test('accept guarded preflight operation '+op,()=>assert.equal(parsePreflightBody({operation:op}).operation,op));
}
for(const body of [null,{},[],{operation:'FUND'},{operation:'CANCEL',execute:true},{operation:1}]){
  test('reject unsafe preflight request '+String(body),()=>assert.throws(()=>parsePreflightBody(body)));
}
test('read-only preflight NEVER authorizes blockchain action',()=>{
  for(const op of ['CANCEL','EXPIRE','REFUND','ORACLE_CONFIRM','DB_RECONCILE']) {
    const r=previewOperation({operation:op,chainStatus:'AWAITING_DELIVERY',dbStatus:'AWAITING_DELIVERY',deadline:1,now:10000000});
    assert.equal(r.executionAuthorized,false);assert.equal(r.blockchainWriteRequested,false);
  }
});
test('expire blocked if Oracle submission ambiguous',()=>{
  for(const status of ['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED']) {
    const r=previewOperation({operation:'EXPIRE',chainStatus:'AWAITING_DELIVERY',dbStatus:'AWAITING_DELIVERY',deadline:1,now:10000000,b16Status:status});
    assert.equal(r.candidate,false);
  }
});
test('refund requires confirmed expiry',()=>{
  assert.equal(previewOperation({operation:'REFUND',chainStatus:'EXPIRED',dbStatus:'EXPIRED'}).candidate,false);
  assert.equal(previewOperation({operation:'REFUND',chainStatus:'EXPIRED',dbStatus:'EXPIRED',expireStatus:'CONFIRMED'}).candidate,true);
});
test('expire blocks before deadline',()=>{
  const r=previewOperation({operation:'EXPIRE',chainStatus:'AWAITING_DELIVERY',dbStatus:'AWAITING_DELIVERY',deadline:100,now:99000});
  assert.equal(r.candidate,false);
});
test('no broadcast or signing in core implementation',async()=>{
  const {readFileSync}=await import('node:fs');
  const {fileURLToPath}=await import('node:url');
  const src=readFileSync(fileURLToPath(new URL('./b18-api-core.mjs',import.meta.url)),'utf8');
  for(const name of ['sendRawTransaction','eth_sendRawTransaction','new Wallet(','PrivateKey.from','spawnSync','execFile']){
    assert.equal(src.includes(name),false,`core should not use ${name}`);
  }
});

// Prisma Decimal2 live-match regression: Prisma 7 returns Decimal2 for these fields.
test('Decimal2 match serialization supports distanceKm and score',()=>{
  class Decimal2 {
    constructor(s) { this.s=s; }
    toString() { return this.s; }
  }

  const result=publicMatch({
    ...match,
    distanceKm:new Decimal2('1.2345'),
    score:new Decimal2('0.987654321')
  });

  assert.equal(result.distanceKm,'1.2345');
  assert.equal(result.score,'0.987654321');
  assert.equal(result.passwordHash,undefined);
});
