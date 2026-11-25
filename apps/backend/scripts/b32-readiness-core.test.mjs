import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectHour,summarizeDay} from './b32-readiness-core.mjs';
const u=(i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const m=(i)=>`0x${String(i).padStart(40,'0')}`;
function fixture(){
 const records=Array.from({length:12},(_,j)=>{
  const i=j+1, buyer=i===1;
  return {user_id:u(i),snapshot_id:u(100),production_wh:buyer?'0':i===2?'100':'0',consumption_wh:buyer?'50':'0',net_energy_wh:buyer?'-50':i===2?'100':'0',market_role:buyer?'BUYER':i===2?'SELLER':'NEUTRAL',available_energy_wh:buyer?'0':i===2?'100':'0',required_energy_wh:buyer?'50':'0',energy_type:'SOLAR',ask_price_microusd_per_kwh:buyer?null:i===2?'101':null,max_price_microusd_per_kwh:buyer?'102':null};
 });
 return {slot:'2026-11-10T10:00:00Z',imports:[{id:u(100),record_count:12,schema_version:'1.0.0',generator_version:'1.0.0'}],records,matchingRuns:[{snapshot_id:u(100),match_count:1}],matches:[{id:u(999),buyer_id:u(1),seller_id:u(2),quantity_wh:'50',unit_price_microusd_per_kwh:'101',total_amount_microusd:'5',seller_energy_type:'SOLAR',status:'SELECTED'}],wallets:records.map((r,i)=>({user_id:r.user_id,evm_address:m(i+1)})),v2Markets:[],v2Allocations:[]};
}
test('valid historical match requires original B11 source replay before V2 authority',()=>{
 const r=inspectHour(fixture()); assert.equal(r.state,'ORIGINAL_B11_REPLAY_REQUIRED');assert.equal(r.provisionalBaseUnits,'5');assert.deepEqual(r.errors,[]);
});
test('B12 partial buyer fulfillment blocks authorization',()=>{
 const f=fixture();f.matches[0].quantity_wh='25';const r=inspectHour(f);assert.equal(r.state,'BLOCKED');assert.ok(r.errors.includes('BUYER_NOT_FULLY_SATISFIED'));
});
test('seller oversell blocks even if legacy match is selected',()=>{
 const f=fixture();f.matches[0].quantity_wh='101';f.records[0].required_energy_wh='101';f.records[0].net_energy_wh='-101';f.records[0].consumption_wh='101';const r=inspectHour(f);assert.ok(r.errors.includes('SELLER_OVERALLOCATED'));
});
test('one existing V2 market cannot be repromoted',()=>{
 const f=fixture();f.v2Markets=[{id:'already'}];const r=inspectHour(f);assert.equal(r.state,'EXISTING_V2_RECONCILE_ONLY');
});
test('empty B12 results create no artificial payments',()=>{
 const f=fixture();f.matches=[];f.matchingRuns[0].match_count=0;const r=inspectHour(f);assert.equal(r.state,'NO_B12_MATCH');assert.equal(r.provisionalBaseUnits,'0');
});
test('orphan historical match blocks',()=>{
 const f=fixture();f.matchingRuns=[];const r=inspectHour(f);assert.equal(r.state,'BLOCKED');assert.ok(r.errors.includes('B12_MATCHES_WITHOUT_UNIQUE_RUN'));
});
test('missing trusted household wallet blocks',()=>{
 const f=fixture();f.wallets.pop();const r=inspectHour(f);assert.equal(r.state,'BLOCKED');assert.ok(r.errors.includes('HOUSEHOLD_WALLET_MISSING'));
});
test('half-even repricing discrepancy is disclosed, not silently promoted',()=>{
 const f=fixture();f.matches[0].unit_price_microusd_per_kwh='110';f.records[1].ask_price_microusd_per_kwh='110';f.records[0].max_price_microusd_per_kwh='120';f.matches[0].total_amount_microusd='5';const r=inspectHour(f);assert.equal(r.state,'ORIGINAL_B11_REPLAY_REQUIRED');assert.ok(r.warnings.includes('HALF_EVEN_REPRICING_REQUIRED'));assert.equal(r.provisionalBaseUnits,'6');
});
test('full day summary counts only 24 distinct hours',()=>{
 const f=fixture(), rows=Array.from({length:24},(_,h)=>({ ...inspectHour({...f,slot:`2026-11-10T${String(h).padStart(2,'0')}:00:00Z`}),slot:`2026-11-10T${String(h).padStart(2,'0')}:00:00Z`}));
 const s=summarizeDay(rows);assert.equal(s.hours,24);assert.equal(s.historicalMatches,24);assert.equal(s.hoursNeedingReplay,24);
 assert.throws(()=>summarizeDay(rows.slice(0,23)));
});
