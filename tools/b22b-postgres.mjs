import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {ingestLocalHour} from '../apps/backend/scripts/b22a-ingestion.mjs';
import {prepareHourly} from '../apps/backend/scripts/b22-hourly-core.mjs';
import {processFinalizedHour} from '../apps/backend/scripts/b22b-matching.mjs';
const {Client}=pg;
const owner=new Client({connectionString:process.env.B22_TEST_DATABASE_URL}),match=new Client({connectionString:process.env.B22_MATCH_DATABASE_URL}),other=new Client({connectionString:process.env.B22_MATCH_DATABASE_URL}),roster=new Client({connectionString:process.env.B22_ROSTER_DATABASE_URL}),ingest=new Client({connectionString:process.env.B22_INGEST_DATABASE_URL});
await Promise.all([owner.connect(),match.connect(),other.connect(),roster.connect(),ingest.connect()]);
try{
 const slot='2026-10-17T13:00:00Z';
 const profiles=(await owner.query('SELECT profiles FROM "B22HourlyRegistry" WHERE "intervalStart"=$1 ORDER BY revision DESC LIMIT 1',['2026-10-17T08:00:00Z'])).rows[0].profiles;
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,2)',['44444444-2222-4222-8222-222222222222',slot,'2026-10-17T14:00:00Z',JSON.stringify(profiles),'ignored']);
 await ingestLocalHour(ingest,slot,{execute:true});
 await assert.rejects(match.query('UPDATE "V2Snapshot" SET status=status WHERE id=(SELECT id FROM "V2Snapshot" LIMIT 1)'),e=>e.code==='42501');
 await assert.rejects(match.query('INSERT INTO "B22HourlyRegistry" DEFAULT VALUES'),e=>e.code==='42501');
 await assert.rejects(match.query('INSERT INTO "B22Ingestion" DEFAULT VALUES'),e=>e.code==='42501');
 await assert.rejects(match.query('INSERT INTO "V2SettlementIntent" DEFAULT VALUES'),e=>e.code==='42501');
 const result=await Promise.all([processFinalizedHour(match,slot,{execute:true}),processFinalizedHour(other,slot,{execute:true})]);
 assert.equal(result[0].planId,result[1].planId);assert.deepEqual(result.map(r=>r.reused).sort(),[false,true]);
 const p=result[0], bought=p.positions.filter(x=>x.role==='BUYER').reduce((a,x)=>a+BigInt(x.matchedWh),0n),sold=p.positions.filter(x=>x.role==='SELLER').reduce((a,x)=>a+BigInt(x.matchedWh),0n);assert.equal(bought,sold);
 const counts=await owner.query('SELECT (SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\') plans',[p.marketId]);assert.equal(counts.rows[0].intents,0);assert.equal(counts.rows[0].plans,p.policyBlocked?0:1);
 console.log(JSON.stringify({status:'PASS B22-B service replay and role boundaries',planStatus:p.status,allocations:p.allocations,matchedWh:String(bought),positions:p.positions.length}));
 // Exact-payment hour found by scanning the unmodified deterministic simulator.
 const exactSlot='2026-10-03T12:00:00Z';
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['55555555-2222-4222-8222-222222222222',exactSlot,'2026-10-03T13:00:00Z',JSON.stringify(profiles),'ignored']);
 const source=await ingestLocalHour(ingest,exactSlot,{execute:true});
 await owner.query('CREATE TABLE b22_guard.b22b_transitions(kind text, status text)');
 await owner.query(`CREATE FUNCTION b22_guard.record_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,b22_guard AS $$ BEGIN INSERT INTO b22_guard.b22b_transitions VALUES (TG_TABLE_NAME,NEW.status); RETURN NEW; END $$`);
 await owner.query('CREATE TRIGGER "B22B_test_plan" AFTER INSERT OR UPDATE ON "V2AllocationPlan" FOR EACH ROW EXECUTE FUNCTION b22_guard.record_transition()');
 await owner.query('CREATE TRIGGER "B22B_test_allocation" AFTER INSERT OR UPDATE ON "V2Allocation" FOR EACH ROW EXECUTE FUNCTION b22_guard.record_transition()');
 const exactResults=await Promise.all([processFinalizedHour(match,exactSlot,{execute:true}),processFinalizedHour(other,exactSlot,{execute:true})]);
 assert.equal(exactResults[0].planId,exactResults[1].planId);assert.deepEqual(exactResults.map(x=>x.reused).sort(),[false,true]);
 const exact=exactResults.find(x=>!x.reused);assert.equal(exact.status,'AUTHORITATIVE');assert.equal(exact.allocations.length,1);assert.equal(exact.allocations[0].quantityWh,'28');assert.equal(exact.allocations[0].unitPriceMicrousdPerKwh,'90750');assert.equal(exact.allocations[0].amountBaseUnits,'2541');assert.equal(exact.allocations[0].remainder,0);
 const transitions=(await owner.query('SELECT kind,status FROM b22_guard.b22b_transitions ORDER BY ctid')).rows;assert.deepEqual(transitions,[{kind:'V2AllocationPlan',status:'DRAFT'},{kind:'V2Allocation',status:'PLANNED'},{kind:'V2Allocation',status:'VALIDATED'},{kind:'V2AllocationPlan',status:'AUTHORITATIVE'}]);
 const state=(await owner.query('SELECT s.status AS snapshot,p.status AS plan,"v2_matching_manifest_hash"(p.manifest)=p."manifestHash" AS hash,(SELECT count(*)::int FROM "V2Position" WHERE "marketId"=p."marketId") AS positions,(SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=p."marketId" AND status=\'AUTHORITATIVE\') AS plans,(SELECT count(*)::int FROM "V2SettlementIntent" WHERE "marketId"=p."marketId") AS intents FROM "V2AllocationPlan" p JOIN "V2Snapshot" s ON s.id=p."snapshotId" WHERE p.id=$1',[exact.planId])).rows[0];
 assert.deepEqual(state,{snapshot:'FINALIZED',plan:'AUTHORITATIVE',hash:true,positions:profiles.length,plans:1,intents:0});assert.equal(source.snapshotId,exact.snapshotId);
 const sums=(await owner.query('SELECT sum("matchedBoughtWh")::text AS bought,sum("matchedSoldWh")::text AS sold FROM "V2Position" WHERE "marketId"=$1',[exact.marketId])).rows[0];assert.deepEqual(sums,{bought:'28',sold:'28'});
 const realSpawn=childProcess.spawnSync;try{childProcess.spawnSync=()=>{throw Error('Python must not run during plan reconciliation');};syncBuiltinESMExports();const replay=await processFinalizedHour(match,exactSlot,{execute:true});assert.equal(replay.planId,exact.planId);assert.equal(replay.status,'AUTHORITATIVE');assert.equal(replay.reused,true);}finally{childProcess.spawnSync=realSpawn;syncBuiltinESMExports();}
 console.log(JSON.stringify({status:'PASS exact ingestion, allocation transitions, conservation, concurrent replay and Python-free reconciliation',snapshot:source.snapshotId,plan:exact.planId,quantityWh:'28',price:'90750',amount:'2541',remainder:0,positions:state.positions}));
 // Read-only substitution simulates a partial historical allocation and consistent projections.
 const realQuery=match.query.bind(match);let sawPartial=false;
 try{match.query=async(...args)=>{const result=await realQuery(...args);const sql=args[0];if(typeof sql==='string'&&sql.startsWith('SELECT * FROM "V2Allocation" WHERE "planId"=')){const a=result.rows[0];a.quantityWh='20';a.amountBaseUnits='1815';a.remainder=0;sawPartial=true;}if(typeof sql==='string'&&sql.startsWith('SELECT * FROM "V2Position" WHERE "marketId"=')){for(const row of result.rows){if(row.role==='BUYER'&&row.matchedBoughtWh==='28'){row.matchedBoughtWh='20';row.unmatchedDeficitWh='8';}if(row.role==='SELLER'&&row.matchedSoldWh==='28'){row.matchedSoldWh='20';row.unmatchedSurplusWh=String(BigInt(row.unmatchedSurplusWh)+8n);}}}return result;};await assert.rejects(processFinalizedHour(match,exactSlot,{execute:true}),/V1 allocation must fully satisfy buyer demand/);assert.equal(sawPartial,true);}finally{match.query=realQuery;}
 assert.equal((await processFinalizedHour(match,exactSlot,{execute:true})).planId,exact.planId);
 console.log('PASS partial buyer fulfillment rejected on read-only historical reconciliation');

 // Test-only query interception injects failures inside the service transaction.
 const failureSlot='2026-08-17T08:00:00Z';
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['66666666-2222-4222-8222-222222222222',failureSlot,'2026-08-17T09:00:00Z',JSON.stringify(profiles),'ignored']);
 const failureSource=await ingestLocalHour(ingest,failureSlot,{execute:true});
 for(const marker of ['INSERT INTO "V2Allocation"','UPDATE "V2Allocation" SET status=','UPDATE "V2AllocationPlan" SET status=']){
  const original=match.query.bind(match);let fired=false;match.query=async(...args)=>{if(!fired&&typeof args[0]==='string'&&args[0].startsWith(marker)){fired=true;throw Error('injected transaction failure');}return original(...args);};
  try{await assert.rejects(processFinalizedHour(match,failureSlot,{execute:true}),/injected transaction failure/);assert.equal(fired,true);}finally{match.query=original;}
  const rollback=(await owner.query('SELECT (SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=$1) plans,(SELECT count(*)::int FROM "V2Allocation" WHERE "marketId"=$1) allocations,(SELECT count(*)::int FROM "V2Position" WHERE "marketId"=$1) positions',[failureSource.marketId])).rows[0];assert.deepEqual(rollback,{plans:0,allocations:0,positions:0});
 }
 const recovered=await processFinalizedHour(match,failureSlot,{execute:true});assert.equal(recovered.status,'AUTHORITATIVE');assert.ok(recovered.allocations.length>0);
 const recoveredAgain=await processFinalizedHour(match,failureSlot,{execute:true});assert.equal(recoveredAgain.planId,recovered.planId);assert.equal(recoveredAgain.reused,true);
 // B21 refuses a competing activation even if an alternative draft exists.
 await owner.query('INSERT INTO "V2AllocationPlan"(id,"marketId","snapshotId","planVersion","manifestHash",manifest) VALUES($1,$2,$3,$4,$5,$6)',['0x'+'b'.repeat(64),exact.marketId,exact.snapshotId,'alternative-test-plan',exact.manifestHash,JSON.stringify(exact.manifest)]);
 await assert.rejects(owner.query('UPDATE "V2AllocationPlan" SET status=\'AUTHORITATIVE\' WHERE id=$1',['0x'+'b'.repeat(64)]),e=>e.code==='23505'&&e.constraint==='V2Plan_one_authoritative_per_market');
 const planCount=(await owner.query('SELECT count(*)::int AS n FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[exact.marketId])).rows[0].n;assert.equal(planCount,1);
 for(const sql of ['UPDATE "V2SnapshotMeasurement" SET "productionWh"="productionWh" WHERE false','ALTER TABLE "V2Snapshot" DISABLE TRIGGER ALL','CREATE TABLE public.b22b_forbidden(id int)'])await assert.rejects(match.query(sql),e=>e.code==='42501');
 console.log('PASS failure injection after plan, allocation and validation: all rolled back; retry authoritative; competing plan rejected; role restrictions held');
 // Both service calls reach BEGIN only after independently computing their manifests.
 const conflictSlot='2026-07-04T04:00:00Z';
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['99999999-2222-4222-8222-222222222222',conflictSlot,'2026-07-04T05:00:00Z',JSON.stringify(profiles),'ignored']);
 const conflictSource=await ingestLocalHour(ingest,conflictSlot,{execute:true});
 function gateBegin(client){const original=client.query.bind(client);let signal,release;const reached=new Promise(r=>signal=r),gate=new Promise(r=>release=r);let armed=true;client.query=async(...args)=>{if(armed&&args[0]==='BEGIN'){armed=false;signal();await gate;}return original(...args);};return {reached,release,restore:()=>{client.query=original;}};}
 const aGate=gateBegin(match),bGate=gateBegin(other);
 try{
  const a=processFinalizedHour(match,conflictSlot,{execute:true,configuration:'v1-default'}).then(value=>({value}),error=>({error}));
  const b=processFinalizedHour(other,conflictSlot,{execute:true,configuration:'v1-disposable-distance-test'}).then(value=>({value}),error=>({error}));
  await Promise.all([aGate.reached,bGate.reached]);aGate.release();const winner=await a;assert.ok(winner.value);assert.equal(winner.value.status,'AUTHORITATIVE');const alternative=structuredClone(winner.value.manifest);alternative.scoringWeights={quantity:'0.2',price:'0.3',distance:'0.35',reputation:'0.15'};const {matchingInputHash}=await import('../packages/shared/v2-identity.mjs');assert.notEqual(matchingInputHash(alternative),winner.value.manifestHash);bGate.release();const loser=await b;assert.match(loser.error?.message??'',/Conflicting authoritative plan/);
  const dbState=(await owner.query('SELECT (SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\') plans,(SELECT count(*)::int FROM "V2Position" WHERE "marketId"=$1) positions,(SELECT count(*)::int FROM "V2SettlementIntent" WHERE "marketId"=$1) intents',[conflictSource.marketId])).rows[0];assert.deepEqual(dbState,{plans:1,positions:profiles.length,intents:0});
  await assert.rejects(processFinalizedHour(other,conflictSlot,{execute:true,configuration:'v1-disposable-distance-test'}),/Conflicting authoritative matching configuration/);
  const replay=await processFinalizedHour(other,conflictSlot);assert.equal(replay.planId,winner.value.planId);
 }finally{aGate.release();bGate.release();aGate.restore();bGate.restore();}
 console.log('PASS overlapping different trusted configurations: one authoritative plan and losing service rejected');

 // Mutate actual Python output only within this disposable test process.
 const attackSlot='2026-07-22T14:00:00Z';
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['77777777-2222-4222-8222-222222222222',attackSlot,'2026-07-22T15:00:00Z',JSON.stringify(profiles),'ignored']);
 const attackSource=await ingestLocalHour(ingest,attackSlot,{execute:true});
 const attacks=[
  ['oversized quantity',m=>{m.quantityWh=Number.MAX_SAFE_INTEGER;},/Output differs from original buyer\/seller quantities, prices or wallets/],
  ['seller selection',m=>{m.sellerId='ffffffff-ffff-4fff-8fff-ffffffffffff';},/Output contains invalid or repeated buyer\/seller identity/],
  ['score',m=>{m.score=0;},/Matching selection or score mismatch/],
  ['price',m=>{m.unitPriceMicrousdPerKwh+=1;},/Output differs from original buyer\/seller quantities, prices or wallets/],
  ['payment amount',m=>{m.totalAmountMicrousd+=1;},/Matching output terms or amount mismatch/],
 ];
 const spawn=childProcess.spawnSync;
 try{
  for(const [label,mutate,expected] of attacks){let injected=false;childProcess.spawnSync=(program,args,opts)=>{const result=spawn(program,args,opts);if(result.status===0&&args.includes('matching_engine.cli')){const path=args[args.indexOf('--output')+1],data=JSON.parse(fs.readFileSync(path,'utf8'));assert.ok(data.matches.length);mutate(data.matches[0]);fs.writeFileSync(path,JSON.stringify(data));injected=true;}return result;};syncBuiltinESMExports();await assert.rejects(processFinalizedHour(match,attackSlot,{execute:true}),expected,label);assert.equal(injected,true);const n=(await owner.query('SELECT count(*)::int AS n FROM "V2AllocationPlan" WHERE "marketId"=$1',[attackSource.marketId])).rows[0].n;assert.equal(n,0);}
 }finally{childProcess.spawnSync=spawn;syncBuiltinESMExports();}
 console.log(`PASS ${attacks.length} corrupted Python outputs rejected before any plan write`);
 // Exercise manifest and monetary integrity at the actual SQL write boundary.
 for(const [label,prefix,index,value,expected] of [
  ['wallet','INSERT INTO "V2Allocation"',6,'0x'+'9'.repeat(40),/allocation parties absent from manifest/],
  ['quotient','INSERT INTO "V2Allocation"',10,'999999',/V2Allocation_terms_check/],
  ['remainder','INSERT INTO "V2Allocation"',11,1,/V2Allocation_terms_check/],
  ['manifest hash','INSERT INTO "V2AllocationPlan"',4,'0x'+'0'.repeat(64),/plan manifest hash mismatch/],
 ]){
  const original=match.query.bind(match);let injected=false;
  try{match.query=async(...args)=>{if(!injected&&typeof args[0]==='string'&&args[0].startsWith(prefix)){injected=true;args[1]=[...args[1]];args[1][index]=value;}return original(...args);};await assert.rejects(processFinalizedHour(match,attackSlot,{execute:true}),expected,label);assert.equal(injected,true);}finally{match.query=original;}
  const state=(await owner.query('SELECT (SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=$1) plans,(SELECT count(*)::int FROM "V2Allocation" WHERE "marketId"=$1) allocations,(SELECT count(*)::int FROM "V2Position" WHERE "marketId"=$1) positions,(SELECT count(*)::int FROM "V2SettlementIntent" WHERE "marketId"=$1) intents',[attackSource.marketId])).rows[0];assert.deepEqual(state,{plans:0,allocations:0,positions:0,intents:0});
 }
 console.log('PASS wrong wallet, quotient, remainder and manifest commitment rejected at SQL boundary and rolled back');

 // An externally inserted incomplete plan is quarantined, never repaired.
 const archived=(await owner.query('SELECT payload FROM "B22Ingestion" WHERE "snapshotId"=$1',[attackSource.snapshotId])).rows[0].payload;
 const cfg=JSON.parse(fs.readFileSync(new URL('../packages/shared/fixtures/matching-config.sample.json',import.meta.url),'utf8'));
 const prepared=prepareHourly(archived,{users:profiles},cfg,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:profiles.length});
 const unknownId='0x'+'d'.repeat(64);
 await owner.query('INSERT INTO "V2AllocationPlan"(id,"marketId","snapshotId","planVersion","manifestHash",manifest) VALUES($1,$2,$3,$4,$5,$6)',[unknownId,attackSource.marketId,attackSource.snapshotId,'external-incomplete',prepared.manifestHash,JSON.stringify(prepared.manifest)]);
 await assert.rejects(processFinalizedHour(match,attackSlot,{execute:true}),/Existing alternative or partial draft requires review/);
 const unknownState=(await owner.query('SELECT status,(SELECT count(*)::int FROM "V2Allocation" WHERE "planId"=$1) AS allocations FROM "V2AllocationPlan" WHERE id=$1',[unknownId])).rows[0];assert.deepEqual(unknownState,{status:'DRAFT',allocations:0});
 // A newly approved correction cannot replace a previously authorized plan.
 const revised=structuredClone(profiles);revised[0].reputation--;await owner.query('UPDATE users SET reputation=reputation-1 WHERE id=$1',[revised[0].userId]);
 await roster.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,2)',['88888888-2222-4222-8222-222222222222',exactSlot,'2026-10-03T13:00:00Z',JSON.stringify(revised),'ignored']);
 await assert.rejects(ingestLocalHour(ingest,exactSlot,{execute:true,correction:true}),/Correction blocked after authoritative plan/);
 const replayAfter=await processFinalizedHour(match,exactSlot,{execute:true});assert.equal(replayAfter.planId,exact.planId);
 console.log('PASS incomplete draft quarantined and correction blocked after authoritative plan');




} finally {await Promise.allSettled([owner.end(),match.end(),other.end(),roster.end(),ingest.end()]);}
