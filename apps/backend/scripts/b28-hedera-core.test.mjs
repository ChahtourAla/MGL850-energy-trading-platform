import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteHalfEven,uint,assertPinnedMarket,assertExecutionApproval,assertDeploymentInputs,assertNoPrior,MARKET,PLAN,SNAPSHOT,SNAPSHOT_HASH,MANIFEST_HASH,PRICING,CHOSEN,ADMIN} from './b28-hedera-core.mjs';
const base={id:'0x'+'1'.repeat(64),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',remainder:494,buyerId:CHOSEN.buyerId,sellerId:CHOSEN.sellerId,buyerAddress:CHOSEN.buyerAddress,sellerAddress:CHOSEN.sellerAddress,quantityWh:246n,unitPriceMicrousdPerKwh:85189n,amountBaseUnits:20956n};
// The 14:00 UTC B11 amounts are pinned to the previously verified B28.1 plan.
const records=()=>{
 const other=(id,amount,q,remainder)=>({id:'0x'+id.repeat(64),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',remainder,buyerId:'other'+id,sellerId:'seller'+id,buyerAddress:CHOSEN.buyerAddress,sellerAddress:CHOSEN.sellerAddress,quantityWh:BigInt(q),unitPriceMicrousdPerKwh:154714n,amountBaseUnits:BigInt(amount)});
 return [base,other('2',39297,254,356),other('3',397924,2572,408)];
};
test('round-half-even is exact for values below, above and at half',()=>{
 assert.deepEqual(quoteHalfEven('1','1499'),{amountBaseUnits:'1',remainder:499,errorNumerator:'-499'});
 assert.deepEqual(quoteHalfEven('1','1500'),{amountBaseUnits:'2',remainder:500,errorNumerator:'500'});
 assert.deepEqual(quoteHalfEven('1','2500'),{amountBaseUnits:'2',remainder:500,errorNumerator:'-500'});
 assert.deepEqual(quoteHalfEven('1','2501'),{amountBaseUnits:'3',remainder:501,errorNumerator:'499'});
});
test('precision uses bigint and bounds',()=>{
 assert.throws(()=>uint('1e3'),/Invalid/);
 assert.throws(()=>uint('-1'),/Invalid/);
 assert.throws(()=>quoteHalfEven(0,1000),/Invalid/);
 assert.throws(()=>quoteHalfEven('9223372036854775808',1),/Invalid/);
});
test('pinned proposal permits only verified 3 allocations and rejects mutations',()=>{
 const r=records(),m={id:MARKET,status:'MATCHED',namespace:'hourly',mode:'HOURLY'},s={id:SNAPSHOT,marketId:MARKET,status:'FINALIZED',payloadHash:SNAPSHOT_HASH},p={id:PLAN,marketId:MARKET,snapshotId:SNAPSHOT,status:'AUTHORITATIVE',manifestHash:MANIFEST_HASH,manifest:{snapshotHash:SNAPSHOT_HASH,pricingPolicyVersion:PRICING}};
 assert.equal(assertPinnedMarket(m,s,p,r).amountBaseUnits,20956n);
 assert.throws(()=>assertPinnedMarket(m,s,p,r.map((x,i)=>i===0?{...x,amountBaseUnits:20957n}:x)),/Incorrect rounded price/);
 assert.throws(()=>assertPinnedMarket({...m,status:'CANCELLED'},s,p,r),/readback mismatch/);
});
test('explicit send approval binds plan, allocation and exact amount',()=>{
 const props={mode:'execute',allocation:base.id,amount:'20956',plan:PLAN,confirm:'I_AUTHORIZE_ONE_HEDERA_TESTNET_TRADE',allowCustody:'YES'};
 assert.equal(assertExecutionApproval(props,base),true);
 for(const change of [{amount:'20957'},{plan:MARKET},{allocation:MARKET},{allowCustody:'NO'},{confirm:'ok'},{mode:'preview'}])assert.throws(()=>assertExecutionApproval({...props,...change},base),/approval required/);
});
test('deployment role separation and pinned admin',()=>{
 const operator='0x'+'1'.repeat(40),pauser='0x'+'2'.repeat(40);
 assert.doesNotThrow(()=>assertDeploymentInputs(ADMIN,operator,pauser));
 assert.throws(()=>assertDeploymentInputs(ADMIN,ADMIN,pauser),/distinct/);
 assert.throws(()=>assertDeploymentInputs(operator,pauser,'0x'+'3'.repeat(40)),/administrator/);
});
test('existing settlement or attempt forces reconciliation',()=>{
 assert.doesNotThrow(()=>assertNoPrior(null,[]));
 assert.throws(()=>assertNoPrior({status:'CONFIRMED'},[]),/reconcile/);
 assert.throws(()=>assertNoPrior(null,[{txHash:'0x...'}]),/reconcile/);
});
