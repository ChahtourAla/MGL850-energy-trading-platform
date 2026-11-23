import test from 'node:test';
import assert from 'node:assert/strict';
import {marketId,snapshotHash,matchingInputHash} from '../../../packages/shared/v2-identity.mjs';
import {makeB28Proposal,buildB28Statements,validateCommittedRows,B28_PRICING_POLICY} from './b28-v2-core.mjs';

const idBuyer='bf625602-1885-5938-8982-d6058d51e5cc';
const idSeller='849a45cc-f3b2-5c75-8fe9-3e371ceea410';
const bAddress='0x5e77aa89c832f9d1cd2d7a28ecc622563031cb0f';
const sAddress='0x133b23b613209ca21ea8a6138f7215c288e5c99f';
const sourceId='7372cfa7-d41f-5246-969a-5ccfb6033a7f';
const start='2026-11-10T14:00:00.000Z',end='2026-11-10T15:00:00.000Z';
const market=marketId('hourly','HOURLY',start,end);
function fixture(){
 const common={timeSlot:start,xKm:'0',yKm:'0',reputation:'50',preferredEnergyType:'ANY'};
 const participants=[
 {userId:idBuyer,...common,productionWh:'0',consumptionWh:'246',marketRole:'BUYER',availableWh:'0',requiredWh:'246',energyType:null,askPriceMicrousdPerKwh:null,maxPriceMicrousdPerKwh:'100000',evmAddress:bAddress},
 {userId:idSeller,...common,productionWh:'500',consumptionWh:'0',marketRole:'SELLER',availableWh:'500',requiredWh:'0',energyType:'SOLAR',askPriceMicrousdPerKwh:'85187',maxPriceMicrousdPerKwh:null,evmAddress:sAddress},
 ];
 const hash=snapshotHash(market,participants.map(x=>({userId:x.userId,productionWh:x.productionWh,consumptionWh:x.consumptionWh})));
 const manifest={schemaVersion:'1.0.0',marketId:market,snapshotHash:hash,intervalStart:start,intervalEnd:end,algorithmVersion:'1.0.0',pricingPolicyVersion:'SELLER_ASK_V1',maximumDistanceKm:'10',scoringWeights:{quantity:'0.25',price:'0.25',distance:'0.25',reputation:'0.25'},participants};
 const old={marketId:market,snapshotHash:hash,manifest,manifestHash:matchingInputHash(manifest),allocations:[{buyerId:idBuyer,sellerId:idSeller,quantityWh:'246',unitPriceMicrousdPerKwh:'85187'}],positions:[{},{}]};
 return {source:{marketId:market,snapshotHash:hash},legacy:old,sourceId};
}
const getPlan=()=>makeB28Proposal(fixture());
const info=(p)=>({slot:'2026-11-10T14:00:00Z',configHash:'0x'+'a'.repeat(64),b11Import:{id:p.snapshotId,generatorVersion:'1.0.0',schemaVersion:'1.0.0',importedAt:'2026-11-11T00:00:00Z'},b11Digest:'b'.repeat(64)});

test('versioned market proposal is deterministic and independently hashed',()=>{
 const a=getPlan(),b=getPlan();assert.deepEqual(a,b);
 assert.notEqual(a.manifestHash,fixture().legacy.manifestHash);
 assert.equal(a.manifestHash,matchingInputHash(a.manifest));
 assert.equal(a.policy,B28_PRICING_POLICY);
 assert.equal(a.planVersion,'b28-'+a.manifestHash.slice(2));
 assert.match(a.planId,/^0x[0-9a-f]{64}$/);
});
test('half-even proposal preserves original economic terms but uses distinct allocation identity',()=>{
 const p=getPlan(),a=p.allocations[0];
 assert.equal(a.quantityWh,'246');assert.equal(a.unitPriceMicrousdPerKwh,'85187');
 assert.equal(a.amountBaseUnits,'20956');assert.equal(a.remainder,2);
 assert.equal(a.roundingDeltaNumerator,'-2');
 assert.equal(a.pricingVersion,'b28-teusd-half-even-1');
 assert.equal(a.status,'VALIDATED');
});
test('market positions conserve energy, including unfilled seller supply',()=>{
 const p=getPlan();
 const buyer=p.positions.find(x=>x.userId===idBuyer),seller=p.positions.find(x=>x.userId===idSeller);
 assert.equal(buyer.matchedBoughtWh,'246');assert.equal(buyer.unmatchedDeficitWh,'0');
 assert.equal(seller.matchedSoldWh,'246');assert.equal(seller.unmatchedSurplusWh,'254');
});
test('conflicting source hash rejects proposal',()=>{
 const x=fixture();x.source.snapshotHash='0x'+'0'.repeat(64);assert.throws(()=>makeB28Proposal(x),/source\/proposal/);
});
test('matching policy or unexplained party change rejected',()=>{
 const x=fixture();x.legacy.manifest.pricingPolicyVersion='DIFFERENT';x.legacy.manifestHash=matchingInputHash(x.legacy.manifest);
 assert.throws(()=>makeB28Proposal(x),/only supports/);
 const y=fixture();y.legacy.allocations[0].buyerId=idSeller;
 assert.throws(()=>makeB28Proposal(y),/invalid matching parties/);
});
test('no match must not create an authoritative market',()=>{
 const x=fixture();x.legacy.allocations=[];assert.throws(()=>makeB28Proposal(x),/no-match/);
});
test('SQL statements are parameterized and stage snapshot finalization before plan',()=>{
 const p=getPlan(),q=buildB28Statements(p,info(p));
 assert.equal(q.filter(x=>x.sql.startsWith('INSERT INTO "V2SnapshotMeasurement"')).length,2);
 assert.equal(q.filter(x=>x.sql.startsWith('INSERT INTO "V2Allocation"')).length,1);
 assert.equal(q.filter(x=>x.sql.startsWith('INSERT INTO "V2SettlementIntent"')).length,0);
 assert.equal(q.filter(x=>x.sql.startsWith('INSERT INTO "V2Position"')).length,2);
 assert.ok(q.findIndex(x=>x.sql.startsWith('UPDATE "V2Snapshot"'))<q.findIndex(x=>x.sql.startsWith('INSERT INTO "V2AllocationPlan"')));
 assert.ok(q.findIndex(x=>x.sql.startsWith('UPDATE "V2AllocationPlan"'))>q.findIndex(x=>x.sql.startsWith('UPDATE "V2Allocation"')));
 assert.ok(q.every(x=>Array.isArray(x.values)&&!x.sql.includes(idBuyer)&&!x.sql.includes(sAddress)));
});
test('unverified B11 metadata cannot generate commit statements',()=>{
 const p=getPlan(),meta=info(p);meta.b11Digest='invalid';assert.throws(()=>buildB28Statements(p,meta),/unverified/);
});
test('verified readback validates all allocation and position terms',()=>{
 const p=getPlan();const rows={market:{id:p.marketId,status:'MATCHED'},snapshot:{id:p.snapshotId,status:'FINALIZED',payloadHash:p.snapshotHash},dbPlan:{id:p.planId,status:'AUTHORITATIVE',manifestHash:p.manifestHash,planVersion:p.planVersion},allocations:p.allocations.map(x=>({...x})),positions:p.positions.map(x=>({...x}))};
 assert.equal(validateCommittedRows(p,rows).allocations,1);
 rows.allocations[0].amountBaseUnits='20957';
 assert.throws(()=>validateCommittedRows(p,rows),/allocation mismatch/);
});
test('readback refuses partial and mismatched committed state',()=>{
 const p=getPlan();const rows={market:{id:p.marketId,status:'FINALIZED'},snapshot:{id:p.snapshotId,status:'FINALIZED',payloadHash:p.snapshotHash},dbPlan:{id:p.planId,status:'DRAFT',manifestHash:p.manifestHash,planVersion:p.planVersion},allocations:[],positions:[]};
 assert.throws(()=>validateCommittedRows(p,rows),/readback mismatch/);
});
