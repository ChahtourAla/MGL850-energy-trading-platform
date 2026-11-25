import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteHalfEven,uint,assertPinnedMarket,assertExecutionApproval,assertDeploymentInputs,assertNoPrior,MARKET,PLAN,SNAPSHOT,SNAPSHOT_HASH,MANIFEST_HASH,PRICING,CHOSEN,ADMIN,PINNED_PLAN_VERSION} from './b28-hedera-core.mjs';
import {allocationId as deriveId} from '../../../packages/shared/v2-identity.mjs';
const base={id:deriveId(MARKET,SNAPSHOT_HASH,CHOSEN.buyerId,CHOSEN.sellerId,CHOSEN.buyerAddress.toLowerCase(),CHOSEN.sellerAddress.toLowerCase(),'246','85189','1.0.0',PRICING,PINNED_PLAN_VERSION),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',remainder:494,buyerId:CHOSEN.buyerId,sellerId:CHOSEN.sellerId,buyerAddress:CHOSEN.buyerAddress,sellerAddress:CHOSEN.sellerAddress,quantityWh:246n,unitPriceMicrousdPerKwh:85189n,amountBaseUnits:20956n};
// The 14:00 UTC B11 amounts are pinned to the previously verified B28.1 plan.
base.planVersion=PINNED_PLAN_VERSION;
const records=()=>{
 const others=[
  {id:'2',buyer:'76cc42d6-ae03-514d-8a22-fcc1530a4a16',seller:'e0742bb7-4b60-5679-b59b-35f36e7a75d0',q:254,amount:39297,remainder:356},
  {id:'3',buyer:'3e06a60f-af1f-5715-9712-1df78c6d1e26',seller:'e0742bb7-4b60-5679-b59b-35f36e7a75d0',q:2572,amount:397924,remainder:408},
 ];
 return [base,...others.map(x=>({id:deriveId(MARKET,SNAPSHOT_HASH,x.buyer,x.seller,'0x'+x.id.repeat(40),'0x'+'a'.repeat(40),String(x.q),'154714','1.0.0',PRICING,PINNED_PLAN_VERSION),marketId:MARKET,planId:PLAN,snapshotId:SNAPSHOT,status:'VALIDATED',pricingVersion:PRICING,algorithmVersion:'1.0.0',planVersion:PINNED_PLAN_VERSION,remainder:x.remainder,buyerId:x.buyer,sellerId:x.seller,buyerAddress:'0x'+x.id.repeat(40),sellerAddress:'0x'+'a'.repeat(40),quantityWh:BigInt(x.q),unitPriceMicrousdPerKwh:154714n,amountBaseUnits:BigInt(x.amount)}))];
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
 const r=records(),m={id:MARKET,status:'MATCHED',namespace:'hourly',mode:'HOURLY'},s={id:SNAPSHOT,marketId:MARKET,status:'FINALIZED',payloadHash:SNAPSHOT_HASH},p={id:PLAN,marketId:MARKET,snapshotId:SNAPSHOT,status:'AUTHORITATIVE',manifestHash:MANIFEST_HASH,planVersion:PINNED_PLAN_VERSION,manifest:{snapshotHash:SNAPSHOT_HASH,pricingPolicyVersion:PRICING}};
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

test('selection explicitly allows either of the other verified allocations',()=>{
 const r=records(),m={id:MARKET,status:'MATCHED',namespace:'hourly',mode:'HOURLY'},
  s={id:SNAPSHOT,marketId:MARKET,status:'FINALIZED',payloadHash:SNAPSHOT_HASH},
  p={id:PLAN,marketId:MARKET,snapshotId:SNAPSHOT,status:'AUTHORITATIVE',manifestHash:MANIFEST_HASH,planVersion:PINNED_PLAN_VERSION,manifest:{snapshotHash:SNAPSHOT_HASH,pricingPolicyVersion:PRICING}};
 assert.equal(assertPinnedMarket(m,s,p,r,r[1].id).id,r[1].id);
 assert.equal(assertPinnedMarket(m,s,p,r,r[2].id).id,r[2].id);
 assert.throws(()=>assertPinnedMarket(m,s,p,r,'0x'+'f'.repeat(64)),/not part/);
 assert.throws(()=>assertPinnedMarket(m,s,p,r.map((x,i)=>i===1?{...x,buyerId:'wrong'}:x)),/household\/energy\/payment/);
 assert.throws(()=>assertPinnedMarket(m,s,p,r.map((x,i)=>i===1?{...x,buyerAddress:x.sellerAddress}:x)),/household\/energy\/payment/);
 assert.throws(()=>assertPinnedMarket(m,s,p,r.map((x,i)=>i===1?{...x,buyerAddress:'0x'+'b'.repeat(40)}:x)),/canonical wallet-bound identity/);
});
