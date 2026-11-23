import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedPayment, auditData } from './b28-b11-v2-candidate.mjs';

const UUIDS=['849a45cc-f3b2-5c75-8fe9-3e371ceea410','6e5b6e99-ceea-5a64-be37-6adbe4c2a3ad'];
function sample(){
  const records=Array.from({length:12},(_,i)=>({
    user_id:i<2?UUIDS[i]:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
    snapshot_id:'00000000-0000-4000-8000-000000000999',
    production_wh:i===0?'0':'1000', consumption_wh:i===0?'1000':'0',
    net_energy_wh:i===0?'-1000':'1000',market_role:i===0?'BUYER':'SELLER',
    available_energy_wh:i===0?null:'1000',required_energy_wh:i===0?'1000':null,
    energy_type:'SOLAR',ask_price_microusd_per_kwh:i===0?null:'500000',max_price_microusd_per_kwh:i===0?'500000':null,
  }));
  const wallets=records.map((r,i)=>({user_id:r.user_id,evm_address:`0x${i.toString(16).padStart(40,'0')}`,hedera_account_id:`0.0.${1000+i}`}));
  const matches=[{id:'00000000-0000-4000-8000-000000000333',buyer_id:records[0].user_id,seller_id:records[1].user_id,quantity_wh:'1000',unit_price_microusd_per_kwh:'500000',total_amount_microusd:'500000',seller_energy_type:'SOLAR',status:'SELECTED'}];
  return {importRow:{id:'00000000-0000-4000-8000-000000000999',record_count:12,generator_version:'1.0.0',schema_version:'1.0.0'},records,matchingRuns:[{match_count:1,algorithm_version:'1.0.0'}],matches,wallets,slot:'2026-11-10T14:00:00Z',existingV2:0};
}

test('exact six-decimal pricing',()=>assert.deepEqual(expectedPayment('1000','500000'),{baseUnits:500000n,remainder:0n}));
test('fractional base unit is flagged',()=>assert.deepEqual(expectedPayment('1','500001'),{baseUnits:500n,remainder:1n}));
test('precheck passes compatible historical sample without asserting V2 authority',()=>{
  const r=auditData(sample());assert.equal(r.state,'B11_B12_PRECHECK_PASS_ONLY');assert.equal(r.matches.length,1);assert.equal(r.matches[0].teusd,'0.500000');
});
test('rejects wrong snapshot linkage',()=>{
  const s=sample();s.records[0].snapshot_id='00000000-0000-4000-8000-000000000123';assert.ok(auditData(s).errors.includes('B11_SNAPSHOT_ID_MISMATCH'));
});
test('rejects seller energy oversell',()=>{
  const s=sample();s.records[1].available_energy_wh='500';assert.ok(auditData(s).errors.includes('SELLER_ENERGY_ROLE_MISMATCH'));
});
test('rejects buyer price excess',()=>{
  const s=sample();s.records[0].max_price_microusd_per_kwh='400000';assert.ok(auditData(s).errors.includes('BUYER_PRICE_CAP_EXCEEDED'));
});
test('rejects duplicate wallets',()=>{
  const s=sample();s.wallets[1].evm_address=s.wallets[0].evm_address;assert.ok(auditData(s).errors.includes('INVALID_OR_DUPLICATE_WALLET'));
});
test('does not treat an already-existing V2 market as clean',()=>{
  const s=sample();s.existingV2=1;assert.ok(auditData(s).errors.includes('V2_RECORDS_ALREADY_PRESENT_RECONCILE_FIRST'));
});
test('rejects partial B22 v1 buyer fulfillment',()=>{
  const s=sample();s.matches[0].quantity_wh='500';s.matches[0].total_amount_microusd='250000';const r=auditData(s);assert.ok(r.errors.includes('B22_V1_BUYER_NOT_FULLY_SATISFIED'));
});
test('does not invent missing wallets',()=>{
  const s=sample();s.wallets.pop();assert.ok(auditData(s).errors.includes('HOUSEHOLD_WALLET_MISSING'));
});
