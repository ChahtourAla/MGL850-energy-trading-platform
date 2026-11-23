import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyHour,summarizeHours} from './b28-history-scan-core.mjs';
const id=(i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
function fixture(quantity='1000',price='500000'){
  const records=Array.from({length:12},(_,i)=>({user_id:id(i+1),snapshot_id:id(200),production_wh:i===0?'0':'2000',consumption_wh:i===0?quantity:'0',net_energy_wh:i===0?`-${quantity}`:'2000',market_role:i===0?'BUYER':'SELLER',available_energy_wh:i===0?null:'2000',required_energy_wh:i===0?quantity:null,energy_type:'SOLAR',ask_price_microusd_per_kwh:i===0?null:price,max_price_microusd_per_kwh:i===0?price:null}));
  const wallets=records.map((r,i)=>({user_id:r.user_id,evm_address:'0x'+(i+1).toString(16).padStart(40,'0'),hedera_account_id:`0.0.${100+i}`}));
  const amount=(BigInt(quantity)*BigInt(price)/1000n).toString();
  const matches=[{id:id(500),buyer_id:records[0].user_id,seller_id:records[1].user_id,quantity_wh:quantity,unit_price_microusd_per_kwh:price,total_amount_microusd:amount,seller_energy_type:'SOLAR',status:'SELECTED'}];
  return {slot:'2026-11-10T14:00:00Z',importRow:{id:id(200),record_count:12,schema_version:'1.0.0',generator_version:'1.0.0'},records,matchingRuns:[{id:id(300),snapshot_id:id(200),match_count:1,algorithm_version:'1.0.0'}],matches,wallets,existingV2:0};
}
test('reports valid precheck without claiming authority',()=>{
 const r=classifyHour(fixture());assert.equal(r.status,'PRECHECK_PASS_ONLY');assert.deepEqual(r.errors,[]);assert.equal(r.nonExact,0);
});
test('detects non-exact payment remainder',()=>{
 const r=classifyHour(fixture('246','85187'));assert.equal(r.status,'BLOCKED');assert.equal(r.nonExact,1);assert.equal(r.remainders[0].remainder,'2');assert.ok(r.errors.includes('PAYMENT_NOT_EXACT_IN_6_DECIMAL_TEUSD'));
});
test('reports zero matches separately',()=>{
 const f=fixture();f.matches=[];f.matchingRuns[0].match_count=0;const r=classifyHour(f);assert.equal(r.status,'NO_MATCH');
});
test('reports missing B12 run separately',()=>{
 const f=fixture();f.matchingRuns=[];f.matches=[];const r=classifyHour(f);assert.equal(r.status,'NO_B12_RUN');
});
test('reports existing V2 state as blocker',()=>{
 const f=fixture();f.existingV2=1;const r=classifyHour(f);assert.equal(r.status,'BLOCKED');assert.ok(r.errors.includes('V2_RECORDS_ALREADY_PRESENT_RECONCILE_FIRST'));
});
test('summary distinguishes candidate, blocked and no match',()=>{
 const rows=[classifyHour(fixture()),classifyHour(fixture('246','85187'))];const empty=fixture();empty.matches=[];empty.matchingRuns[0].match_count=0;rows.push(classifyHour(empty));
 const s=summarizeHours(rows);assert.equal(s.scanned,3);assert.equal(s.preliminaryCandidates,1);assert.equal(s.blocked,1);assert.equal(s.noMatch,1);assert.equal(s.nonExactMatches,1);
});
test('blocks orphan historical matches without a B12 run',()=>{
 const f=fixture();f.matchingRuns=[];const r=classifyHour(f);assert.equal(r.status,'BLOCKED');assert.ok(r.errors.includes('B12_MATCHES_WITHOUT_RUN'));
});
