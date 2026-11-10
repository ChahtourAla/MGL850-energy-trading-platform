import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { B17_OPS, B17_STATES, argsB17, uint, transition, protectedWrite, eligibility,
 quote, sameImmutableIntent, signedMatches, receiptDisposition, verifyOperatorEffects,
 statusDbChange, assertAddresses, assertEvidenceId, digest } from './b17-recovery-core.mjs';

const id='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const buyer='0x'+'1'.repeat(40), seller='0x'+'2'.repeat(40), operator='0x'+'3'.repeat(40), escrow='0x'+'4'.repeat(40),token='0x'+'5'.repeat(40);
const ext='0x'+'c'.repeat(64),h='0x'+'a'.repeat(64),data='0x12345678';
const plan={matchId:id,operation:'EXPIRE',externalTradeId:ext,onChainTradeId:'5',chainId:296,
 signerAddress:operator,targetAddress:escrow,buyerAddress:buyer,totalAmountMicrousd:'250232',callDataSha256:digest(data),callData:data,buyer};
const row={...plan,id,nonce:'7',txHash:h,status:'SIGNED'};
const trade={status:'AWAITING_DELIVERY',statusCode:2,totalAmountMicrousd:'250232',deliveryDeadline:'1000',buyer,seller};
const params={operation:'EXPIRE',trade,dbTrade:{status:'AWAITING_DELIVERY'},chainNow:'1061',paused:false,operatorHasRole:true,
 escrowBalance:'250232',b16Journal:null,expireJournal:null};
const cli=(action,operation)=>['--match-id',id,...(action?['--action',action]:[]),...(operation?['--operation',operation]:[])];
for(const operation of Object.keys(B17_OPS))test(`contract mapping ${operation}`,()=>{
 assert.match(B17_OPS[operation].method,/^(cancelTrade|expireTrade|refundTrade)$/);
 assert.ok(B17_OPS[operation].post!==B17_OPS[operation].pre);
});
test('only three operator transitions',()=>assert.deepEqual(Object.keys(B17_OPS),['CANCEL','EXPIRE','REFUND']));
test('read-only inspect is default',()=>assert.deepEqual(argsB17(cli()),{action:'inspect',operation:'',matchId:id}));
for(const action of ['plan','execute','reconcile','sync','verify']){
 for(const op of ['cancel','expire','refund'])test(`CLI ${action} ${op}`,()=>assert.equal(argsB17(cli(action,op)).operation,op.toUpperCase()));
}
test('verify settlement supported',()=>assert.equal(argsB17(cli('verify','settlement')).operation,'SETTLEMENT'));
for(const bad of [cli('execute'),cli('inspect','expire'),cli('execute','settlement'),['--match-id','bogus'],[...cli('execute','expire'),'--foo','x'],[...cli('plan','expire'),'--action','execute'],[...cli('plan','expire'),'--match-id',id],['--match-id']]){
 test(`bad CLI rejected ${bad.join(' ')}`,()=>assert.throws(()=>argsB17(bad)));
}
for(const [v,accept] of [['0',true],['123456789',true],[0,true],[2n,true],['0001',false],['-1',false],['1.2',false],['1e2',false],[' 1',false],['+1',false],['1 ',false],['',false],['0x10',false]]){
 test(`integer ${String(v)} is ${accept?'accepted':'rejected'}`,()=>{
  if(accept)assert.equal(uint(v,'test'),BigInt(v));else assert.throws(()=>uint(v,'test'));
 });
}
test('positive rejects zero',()=>assert.throws(()=>uint(0,'positive',true)));
test('uint256 overflow',()=>assert.throws(()=>uint((1n<<256n).toString(),'overflow')));
const allowed={PLANNED:['SIGNED'],SIGNED:['SUBMITTED'],SUBMITTED:['NEEDS_RECONCILIATION','CONFIRMED','REVERTED'],NEEDS_RECONCILIATION:['CONFIRMED','REVERTED']};
for(const a of B17_STATES){for(const b of B17_STATES){
 test(`transition ${a} to ${b}`,()=>{if(allowed[a]?.includes(b))assert.equal(transition(a,b),true);else assert.throws(()=>transition(a,b));});
}}
test('protected trade #2 disallows writes',()=>assert.throws(()=>protectedWrite('2','EXPIRE',null)));
test('protected trade #2 explicit extra consent',()=>assert.equal(protectedWrite('2','EXPIRE','I_ACCEPT_B17_OPERATION_ON_RESERVED_TRADE_2'),true));
test('other test trade allowed',()=>assert.equal(protectedWrite('3','REFUND',null),true));
test('protected trade rejects unknown operation',()=>assert.throws(()=>protectedWrite('3','FAIL',null)));
test('expire eligible strictly after deadline + guard',()=>assert.equal(eligibility(params).to,'EXPIRED'));
for(const t of ['1000','1001','1059','1060'])test(`expire too early block ${t}`,()=>assert.throws(()=>eligibility({...params,chainNow:t})));
test('expire works one second after guard',()=>assert.equal(eligibility({...params,chainNow:'1061'}).to,'EXPIRED'));
for(const override of [{paused:true},{operatorHasRole:false},{trade:{...trade,status:'COMPLETED',statusCode:4}},
 {trade:{...trade,statusCode:6}},{dbTrade:{status:'COMPLETED'}},{escrowBalance:'250231'},
 {b16Journal:{status:'PLANNED'}},{b16Journal:{status:'SIGNED'}},{b16Journal:{status:'SUBMITTED'}},
 {b16Journal:{status:'NEEDS_RECONCILIATION'}},{b16Journal:{status:'CONFIRMED'}}]){
 test(`expire refuses ${Object.keys(override).join()}:${JSON.stringify(override)}`,()=>assert.throws(()=>eligibility({...params,...override})));
}
test('B16 reverted does not block expire',()=>assert.equal(eligibility({...params,b16Journal:{status:'REVERTED'}}).to,'EXPIRED'));
const cancel={...params,operation:'CANCEL',trade:{...trade,status:'CREATED',statusCode:0},dbTrade:null,chainNow:'100'};
test('cancel unfunded trade',()=>assert.equal(eligibility(cancel).to,'CANCELLED'));
test('cancel refuses funded trade',()=>assert.throws(()=>eligibility({...cancel,trade})));
test('cancel refuses committed completed DB trade',()=>assert.throws(()=>eligibility({...cancel,dbTrade:{status:'COMPLETED'}})));
const refund={...params,operation:'REFUND',trade:{...trade,status:'EXPIRED',statusCode:6},dbTrade:{status:'EXPIRED'},expireJournal:{status:'CONFIRMED',syncedAt:new Date()}};
test('refund eligible after verified expiry',()=>assert.equal(eligibility(refund).to,'REFUNDED'));
for(const change of [{trade},{dbTrade:{status:'AWAITING_DELIVERY'}},{expireJournal:null},{expireJournal:{status:'CONFIRMED'}},
 {expireJournal:{status:'REVERTED',syncedAt:new Date()}},{escrowBalance:'100'}]){
 test(`refund refuses invalid ${Object.keys(change).join()}`,()=>assert.throws(()=>eligibility({...refund,...change})));
}
test('gas quote accepts safe cost',()=>assert.equal(quote({estimate:100_000n,gasPrice:10_000_000_000n,balance:3_000_000_000_000_000_000n}).gasLimit,120000n));
for(const input of [{estimate:500_000n,gasPrice:10_000_000_000n,balance:3_000_000_000_000_000_000n},
 {estimate:100_000n,gasPrice:10_000_000_000_000n,balance:30_000_000_000_000_000_000n},
 {estimate:100_000n,gasPrice:10_000_000_000n,balance:200_000_000_000_000_000n},
 {estimate:0n,gasPrice:1n,balance:1000n}])test(`unsafe gas fee rejected ${String(input.estimate)}`,()=>assert.throws(()=>quote(input)));
test('immutable plan accepted',()=>assert.equal(sameImmutableIntent(row,plan),true));
for(const key of ['operation','externalTradeId','onChainTradeId','signerAddress','targetAddress','totalAmountMicrousd','callDataSha256','chainId']){
 test(`immutable ${key} alteration rejected`,()=>assert.throws(()=>sameImmutableIntent({...row,[key]: key==='chainId'?1:'CORRUPTED'},plan)));
}
const signed={hash:h,from:operator,to:escrow,data,nonce:7,chainId:296,value:0n};
test('signed envelope accepted',()=>assert.equal(signedMatches(signed,row,plan),true));
for(const key of ['hash','from','to','data','nonce','chainId','value'])test(`signed envelope wrong ${key}`,()=>{
 assert.throws(()=>signedMatches({...signed,[key]: key==='value'?1n:'CORRUPTED'},row,plan));
});
const receipt={hash:h,status:1,from:operator,to:escrow};
test('receipt success',()=>assert.equal(receiptDisposition({row,tx:signed,receipt,plan}),'CONFIRMED'));
test('receipt revert',()=>assert.equal(receiptDisposition({row,tx:signed,receipt:{...receipt,status:0},plan}),'REVERTED'));
test('known pending',()=>assert.equal(receiptDisposition({row,tx:signed,receipt:null,plan}),'PENDING'));
test('unknown pending',()=>assert.equal(receiptDisposition({row,tx:null,receipt:null,plan}),'UNKNOWN'));
for(const key of ['hash','from','to','status'])test(`bad receipt ${key}`,()=>assert.throws(()=>receiptDisposition({row,tx:signed,receipt:{...receipt,[key]:'wrong'},plan})));
for(const op of Object.keys(B17_OPS)){
 const rule=B17_OPS[op];const post={status:rule.post,statusCode:rule.code};
 const event={contract:'EnergyTradingEscrow',event:rule.event,args:{onChainTradeId:'5',buyer,amount:'250232'}};
 const transfers=op==='REFUND'?[{contract:'TestEnergyUSD',event:'Transfer',args:{from:escrow,to:buyer,value:'250232'}}]:[];
 const events=[event,...transfers];
 test(`effects ${op} correct`,()=>assert.equal(verifyOperatorEffects({operation:op,events,trade:post,plan,escrow,token}),true));
 test(`effects ${op} wrong event ID`,()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[{...event,args:{...event.args,onChainTradeId:'6'}},...transfers],trade:post,plan,escrow,token})));
 test(`effects ${op} wrong status`,()=>assert.throws(()=>verifyOperatorEffects({operation:op,events,trade:{...post,status:'CREATED'},plan,escrow,token})));
 test(`effects ${op} extra settlement event`,()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[...events,{contract:'EnergyTradingEscrow',event:'TradeSettled',args:{onChainTradeId:'5'}}],trade:post,plan,escrow,token})));
 test(`effects ${op} duplicate event`,()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[...events,event],trade:post,plan,escrow,token})));
 if(op==='REFUND'){
  test('refund must pay correct buyer',()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[{...event,args:{...event.args,buyer:seller}},...transfers],trade:post,plan,escrow,token})));
  test('refund must transfer exact amount',()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[event,{...transfers[0],args:{...transfers[0].args,value:'1'}}],trade:post,plan,escrow,token})));
  test('refund must transfer from escrow',()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[event,{...transfers[0],args:{...transfers[0].args,from:seller}}],trade:post,plan,escrow,token})));
  test('refund must include Transfer',()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[event],trade:post,plan,escrow,token})));
 }else test(`${op} cannot transfer token`,()=>assert.throws(()=>verifyOperatorEffects({operation:op,events:[...events,{contract:'TestEnergyUSD',event:'Transfer',args:{from:escrow,to:buyer,value:'250232'}}],trade:post,plan,escrow,token})));
}
test('DB cancel no row',()=>assert.equal(statusDbChange('CANCEL',null),'NO_TRADE_ROW'));
test('DB cancel created',()=>assert.equal(statusDbChange('CANCEL','CREATED'),'UPDATE'));
test('DB cancel idempotent',()=>assert.equal(statusDbChange('CANCEL','CANCELLED'),'UNCHANGED'));
test('DB expire funded',()=>assert.equal(statusDbChange('EXPIRE','AWAITING_DELIVERY'),'UPDATE'));
test('DB expire idempotent',()=>assert.equal(statusDbChange('EXPIRE','EXPIRED'),'UNCHANGED'));
test('DB refund expired',()=>assert.equal(statusDbChange('REFUND','EXPIRED'),'UPDATE'));
test('DB refund idempotent',()=>assert.equal(statusDbChange('REFUND','REFUNDED'),'UNCHANGED'));
for(const op of Object.keys(B17_OPS))for(const x of ['FAILED','COMPLETED','FUNDED'])test(`DB refuses ${op} from ${x}`,()=>assert.throws(()=>statusDbChange(op,x)));
test('addresses canonical',()=>assert.equal(assertAddresses(buyer,seller,operator,escrow),true));
test('address missing refused',()=>assert.throws(()=>assertAddresses('BAD',seller,operator,escrow)));
test('self-trade rejected',()=>assert.throws(()=>assertAddresses(buyer,buyer,operator,escrow)));
test('bytes32 valid',()=>assert.equal(assertEvidenceId(ext),true));
test('bytes32 bad',()=>assert.throws(()=>assertEvidenceId('wrong')));
test('source uses one raw broadcast callsite and explicit confirmation',()=>{
 const source=readFileSync(fileURLToPath(new URL('./b17-recovery.mjs',import.meta.url)),'utf8');
 assert.equal((source.match(/eth_sendRawTransaction/g)??[]).length,1);
 assert.match(source,/B17_ONCHAIN_CONFIRM/);
 assert.match(source,/B17_PROTECTED_TRADE_CONFIRM/);
 assert.match(source,/signedTxCiphertext/);
 assert.match(source,/NEEDS_RECONCILIATION/);
 assert.doesNotMatch(source,/WALLET_ENCRYPTION_KEY_B64|privateKeyDecryption|mint\(/);
});
