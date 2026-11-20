/** Synthetic B22-A persistence smoke test, restricted to the disposable harness. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {ingestLocalHour,inspectHistoricalHour} from '../apps/backend/scripts/b22a-ingestion.mjs';
import {marketId} from '../packages/shared/v2-identity.mjs';
import {prepareHourly} from '../apps/backend/scripts/b22-hourly-core.mjs';
const require=createRequire(new URL('../apps/backend/package.json',import.meta.url)),{Client}=require('pg');
const raw=process.env.B22_TEST_DATABASE_URL;if(!raw)throw Error('Missing disposable target');
const target=new URL(raw);if(target.hostname!=='127.0.0.1'||target.pathname!=='/b22_disposable_review'||target.username!=='b22test')throw Error('Unsafe target');
const owner=new Client({connectionString:raw}), rosterClient=new Client({connectionString:process.env.B22_ROSTER_DATABASE_URL}), clients=[new Client({connectionString:process.env.B22_INGEST_DATABASE_URL}),new Client({connectionString:process.env.B22_INGEST_DATABASE_URL})], fixture=JSON.parse(readFileSync(new URL('../packages/shared/fixtures/b22-hourly-prototype.json',import.meta.url)));
// Pause the real service at an existing query boundary without changing production code.
function pauseQuery(client,predicate){
 const original=client.query.bind(client);let release,announce;const reached=new Promise(r=>{announce=r;}), gate=new Promise(r=>{release=r;});let armed=true;
 client.query=async (...args)=>{if(armed&&predicate(...args)){armed=false;announce(args);await gate;}return original(...args);};
 return {reached,release,restore:()=>{client.query=original;}};
}
async function waitForLock(observer,pid){
 for(let i=0;i<200;i++){const r=await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);if(r.rows[0]?.wait_event_type==='Lock')return;await new Promise(resolve=>setTimeout(resolve,25));}
 throw Error(`Expected PostgreSQL lock wait for session ${pid}`);
}
try {
 await Promise.all([owner.connect(),rosterClient.connect(),...clients.map(c=>c.connect())]);const db=owner;const marker=await db.query("SELECT current_database() AS name, EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS ok");assert.equal(marker.rows[0].name,'b22_disposable_review');assert.equal(marker.rows[0].ok,true);
 for(const [client,query] of [[clients[0],'INSERT INTO "B22HourlyRegistry" DEFAULT VALUES'],[rosterClient,'INSERT INTO "B22Ingestion" DEFAULT VALUES'],[rosterClient,'INSERT INTO "V2Snapshot" DEFAULT VALUES'],[clients[0],'ALTER TABLE "V2Snapshot" DISABLE TRIGGER ALL'],[rosterClient,'CREATE TABLE public.b22_forbidden_test(id int)']])await assert.rejects(client.query(query),e=>e.code==='42501');
 const identities=await Promise.all([db,rosterClient,clients[0]].map(c=>c.query('SELECT session_user AS role,current_user AS current')));assert.deepEqual(identities.map(r=>r.rows[0].role),['b22test','b22_roster','b22_ingest']);
 const capabilities=await db.query("SELECT rolname,rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname IN ('b22_roster','b22_ingest') ORDER BY rolname");assert.equal(capabilities.rowCount,2);for(const r of capabilities.rows)assert.equal(r.rolsuper||r.rolcreaterole||r.rolcreatedb,false);
 const isolation=await db.query("SELECT pg_has_role('b22_ingest','b22_roster','member') AS membership,has_schema_privilege('b22_ingest','public','CREATE') AS create_schema,has_table_privilege('b22_roster','\"V2Snapshot\"','INSERT') AS roster_write_snapshot,has_table_privilege('b22_ingest','\"B22HourlyRegistry\"','INSERT') AS ingest_write_roster");assert.deepEqual(isolation.rows[0],{membership:false,create_schema:false,roster_write_snapshot:false,ingest_write_roster:false});
 const users=fixture.snapshot.users.map((u,i)=>({userId:u.userId,name:`Synthetic ${i}`,email:`synthetic${i}@example.com`,physicalAddress:'Simulated road',xKm:u.xKm,yKm:u.yKm,preferredEnergyType:u.preferredEnergyType,reputation:u.reputation,hederaAccountId:`0.0.${1000+i}`,evmAddress:u.evmAddress}));
 await db.query('BEGIN');for(const [i,u] of users.entries()){
  await db.query('INSERT INTO users(id,name,email,password_hash,physical_address,x_km,y_km,reputation,preferred_energy_type,updated_at) VALUES($1,$2,$3,\'synthetic\',$4,$5,$6,$7,$8,now())',[u.userId,u.name,u.email,u.physicalAddress,u.xKm,u.yKm,u.reputation,u.preferredEnergyType]);
  await db.query('INSERT INTO wallets(id,user_id,hedera_account_id,evm_address,public_key,encrypted_private_key,encryption_iv,encryption_auth_tag,updated_at) VALUES($1,$2,$3,$4,\'synthetic\',\'synthetic\',\'synthetic\',\'synthetic\',now())',[fixture.snapshot.users[i].recordId,u.userId,u.hederaAccountId,u.evmAddress]);
 }
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-17T14:00:00Z','2026-10-17T15:00:00Z',JSON.stringify(users),'synthetic-admin']);await db.query('COMMIT');
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T14:00:00Z'),/explicit execute/);
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T13:00:00Z',{execute:true}),/No approved participant registry/);
 await assert.rejects(ingestLocalHour({connectionParameters:{host:'shared.example',database:'other',user:'other'}},'2026-10-17T14:00:00Z',{execute:true}),/non-disposable/);
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-17T12:00:00Z','2026-10-17T13:00:00Z',JSON.stringify([users[0],users[0]]),'synthetic-admin']);
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T12:00:00Z',{execute:true}),/Duplicate approved participant/);
 const unknown={...users[0],userId:'ffffffff-ffff-4fff-8fff-ffffffffffff'};
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['cccccccc-cccc-4ccc-8ccc-cccccccccccc','2026-10-17T11:00:00Z','2026-10-17T12:00:00Z',JSON.stringify([unknown]),'synthetic-admin']);
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T11:00:00Z',{execute:true}),/participant or wallet missing/);
 const draftMarket=marketId('hourly','HOURLY','2026-10-17T10:00:00.000Z','2026-10-17T11:00:00.000Z');
 await db.query('INSERT INTO "V2Market"(id,namespace,mode,"intervalStart","intervalEnd",status,"schemaVersion","configVersion","updatedAt") VALUES($1,\'hourly\',\'HOURLY\',\'2026-10-17 10:00Z\',\'2026-10-17 11:00Z\',\'DISCOVERED\',\'2.0.0\',\'external\',now())',[draftMarket]);
 const marketOnly=await inspectHistoricalHour(clients[0],'2026-10-17T10:00:00Z');assert.equal(marketOnly.state,'QUARANTINED');assert.equal(marketOnly.marketStatus,'DISCOVERED');
 await db.query('INSERT INTO "V2Snapshot"(id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status) VALUES($1,$2,\'2026-10-17 10:00Z\',\'2026-10-17 11:00Z\',\'unknown\',\'1\',$3,$3,\'2.0.0\',1,0,\'{}\',now(),\'PENDING\')',['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',draftMarket,'0x'+'3'.repeat(64)]);
 const draft=await inspectHistoricalHour(clients[0],'2026-10-17T10:00:00Z');assert.equal(draft.state,'QUARANTINED');assert.equal(draft.snapshots[0].status,'PENDING');assert.equal(draft.snapshots[0].measurementCount,0);assert.equal(draft.snapshots[0].provenancePresent,false);await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T10:00:00Z',{execute:true}),/Incomplete or inconsistent historical draft/);
 const untouched=await db.query('SELECT (SELECT count(*)::int FROM "V2SnapshotMeasurement" WHERE "marketId"=$1) AS readings,(SELECT count(*)::int FROM "V2AllocationPlan" WHERE "marketId"=$1) AS plans,(SELECT count(*)::int FROM "V2SettlementIntent" WHERE "marketId"=$1) AS intents',[draftMarket]);assert.deepEqual(untouched.rows[0],{readings:0,plans:0,intents:0});
 await db.query(`CREATE FUNCTION b22_guard.fail_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='FINALIZED' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
 await db.query('CREATE TRIGGER "B22Test_failure" BEFORE UPDATE ON "V2Snapshot" FOR EACH ROW EXECUTE FUNCTION b22_guard.fail_finalization()');
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true}),/injected failure/);
 const rolled=await db.query('SELECT (SELECT count(*)::int FROM "V2Market" WHERE id<>$1) AS markets,(SELECT count(*)::int FROM "V2Snapshot" WHERE "marketId"<>$1) AS snapshots,(SELECT count(*)::int FROM "V2SnapshotMeasurement") AS readings',[draftMarket]);assert.deepEqual(rolled.rows[0],{markets:0,snapshots:0,readings:0});
 await db.query('DROP TRIGGER "B22Test_failure" ON "V2Snapshot"');await db.query('DROP FUNCTION b22_guard.fail_finalization()');
 const results=await Promise.all(clients.map(c=>ingestLocalHour(c,'2026-10-17T14:00:00Z',{execute:true})));assert.equal(results[0].snapshotId,results[1].snapshotId);assert.deepEqual(results.map(r=>r.reused).sort(),[false,true]);
 const check=await db.query('SELECT s.status,"v2_snapshot_measurement_hash"(s.id) AS hash,(SELECT count(*)::int FROM "V2SnapshotMeasurement" WHERE "snapshotId"=s.id) AS n,(SELECT count(*)::int FROM "B22Ingestion" WHERE "snapshotId"=s.id) AS ingestions,(SELECT count(*)::int FROM "V2AllocationPlan") AS plans,(SELECT count(*)::int FROM "V2SettlementIntent") AS intents FROM "V2Snapshot" s WHERE s.id=$1',[results[0].snapshotId]);assert.equal(check.rows[0].status,'FINALIZED');assert.equal(check.rows[0].hash,results[0].payloadHash);assert.equal(check.rows[0].n,7);assert.equal(check.rows[0].ingestions,1);assert.equal(check.rows[0].plans,0);assert.equal(check.rows[0].intents,0);
 const audit=await db.query('SELECT i.principal,r."approvedBy" FROM "B22Ingestion" i JOIN "B22HourlyRegistry" r ON r.id=i."registryId" WHERE i."snapshotId"=$1',[results[0].snapshotId]);assert.deepEqual(audit.rows[0],{principal:'b22_ingest',approvedBy:'b22_roster'});
 await assert.rejects(db.query('UPDATE "V2SnapshotMeasurement" SET "productionWh"="productionWh"+1 WHERE "snapshotId"=$1',[results[0].snapshotId]),/measurements require pending snapshot/);
 await assert.rejects(db.query('UPDATE "B22HourlyRegistry" SET "approvedBy"=\'changed\''),/B22 audit facts are immutable/);
 await db.query('UPDATE users SET reputation=reputation-1 WHERE id=$1',[users[0].userId]);
 const profileReplay=await ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true});assert.equal(profileReplay.snapshotId,results[0].snapshotId);assert.equal(profileReplay.reused,true);
 const originalRead=fs.readFileSync;try{fs.readFileSync=function(path,...args){if(String(path).includes('data-generator')||String(path).includes('python.exe'))throw Error('generator files unavailable');return originalRead.call(this,path,...args);};syncBuiltinESMExports();const archivedWithoutGenerator=await ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true});assert.equal(archivedWithoutGenerator.snapshotId,results[0].snapshotId);}finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
 await db.query('UPDATE users SET reputation=reputation+1 WHERE id=$1',[users[0].userId]);
 const replay=await ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true});assert.equal(replay.snapshotId,results[0].snapshotId);assert.equal(replay.reused,true);
 const revised=structuredClone(users);revised[0].reputation--;
 await db.query('UPDATE users SET reputation=reputation-1 WHERE id=$1',[users[0].userId]);
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,2)',['dddddddd-dddd-4ddd-8ddd-dddddddddddd','2026-10-17T14:00:00Z','2026-10-17T15:00:00Z',JSON.stringify(revised),'synthetic-admin']);
 const archived=await ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true});assert.equal(archived.snapshotId,results[0].snapshotId);
 const correction=await ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true,correction:true});assert.notEqual(correction.snapshotId,results[0].snapshotId);
 const history=await db.query('SELECT id,"supersedesId","payloadHash",status FROM "V2Snapshot" WHERE "marketId"=$1 ORDER BY "collectedAt",id',[results[0].marketId]);assert.equal(history.rows.length,2);assert.ok(history.rows.some(r=>r.id===results[0].snapshotId&&r.payloadHash===results[0].payloadHash&&r.status==='FINALIZED'));assert.ok(history.rows.some(r=>r.id===correction.snapshotId&&r.supersedesId===results[0].snapshotId&&r.status==='FINALIZED'));
 // Seed an existing B21 authoritative plan solely as a test precondition.
 const payload=(await db.query('SELECT payload FROM "B22Ingestion" WHERE "snapshotId"=$1',[correction.snapshotId])).rows[0].payload;
 const matchingConfig=JSON.parse(readFileSync(new URL('../packages/shared/fixtures/matching-config.sample.json',import.meta.url)));
 const prep=prepareHourly(payload,{users:revised},matchingConfig,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:7});
 const plan='0x'+'a'.repeat(64);await db.query('INSERT INTO "V2AllocationPlan"(id,"marketId","snapshotId","planVersion","manifestHash",manifest) VALUES($1,$2,$3,\'test-plan\',$4,$5)',[plan,correction.marketId,correction.snapshotId,prep.manifestHash,JSON.stringify(prep.manifest)]);await db.query('UPDATE "V2AllocationPlan" SET status=\'AUTHORITATIVE\' WHERE id=$1',[plan]);
 const revision3=structuredClone(revised);revision3[0].reputation--;await db.query('UPDATE users SET reputation=reputation-1 WHERE id=$1',[users[0].userId]);
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,3)',['ffffffff-ffff-4fff-8fff-ffffffffffff','2026-10-17T14:00:00Z','2026-10-17T15:00:00Z',JSON.stringify(revision3),'ignored']);
 await assert.rejects(ingestLocalHour(clients[0],'2026-10-17T14:00:00Z',{execute:true,correction:true}),/Correction blocked after authoritative plan/);
 const afterBlock=await db.query('SELECT count(*)::int AS n FROM "V2Snapshot" WHERE "marketId"=$1',[correction.marketId]);assert.equal(afterBlock.rows[0].n,2);
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['99999999-9999-4999-8999-999999999999','2026-10-17T09:00:00Z','2026-10-17T10:00:00Z',JSON.stringify(revision3),'ignored']);
 await rosterClient.query('BEGIN');await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,2)',['88888888-8888-4888-8888-888888888888','2026-10-17T09:00:00Z','2026-10-17T10:00:00Z',JSON.stringify(revision3),'ignored']);
 const pending=ingestLocalHour(clients[0],'2026-10-17T09:00:00Z',{execute:true}).then(value=>({value}),error=>({error}));
 const commitTimer=setTimeout(()=>rosterClient.query('COMMIT').catch(()=>{}),500);const competed=await pending;clearTimeout(commitTimer);assert.match(competed.error?.message??'',/Roster changed during generator execution/);
 const raceMarket=marketId('hourly','HOURLY','2026-10-17T09:00:00.000Z','2026-10-17T10:00:00.000Z');const raceEmpty=await db.query('SELECT count(*)::int AS n FROM "V2Snapshot" WHERE "marketId"=$1',[raceMarket]);assert.equal(raceEmpty.rows[0].n,0);
 // Real overlapping services: A finishes generating revision 1, B commits revision 2 first.
 const conflictSlot='2026-10-17T08:00:00Z';
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['77777777-7777-4777-8777-777777777777',conflictSlot,'2026-10-17T09:00:00Z',JSON.stringify(revision3),'ignored']);
 const pauseA=pauseQuery(clients[0],q=>q==='BEGIN');
 let stale;
 try{
  const attemptA=ingestLocalHour(clients[0],conflictSlot,{execute:true}).then(value=>({value}),error=>({error}));
  await pauseA.reached; // A generated and validated old-roster input, but has not committed.
  const revision4=structuredClone(revision3);revision4[0].reputation--;
  await db.query('UPDATE users SET reputation=reputation-1 WHERE id=$1',[users[0].userId]);
  await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,2)',['66666666-6666-4666-8666-666666666666',conflictSlot,'2026-10-17T09:00:00Z',JSON.stringify(revision4),'ignored']);
  const winner=await ingestLocalHour(clients[1],conflictSlot,{execute:true});assert.equal(winner.reused,false);
  pauseA.release();stale=await attemptA;assert.equal(stale.error?.message,'Roster changed during generator execution');
  const state=await inspectHistoricalHour(clients[1],conflictSlot);assert.equal(state.state,'FINALIZED');assert.equal(state.snapshots.length,1);assert.equal(state.snapshots[0].snapshotId,winner.snapshotId);assert.equal(state.snapshots[0].supersedesId,null);
  const counts=await db.query('SELECT (SELECT count(*)::int FROM "V2Snapshot" WHERE "marketId"=$1) AS snapshots,(SELECT count(*)::int FROM "B22Ingestion" WHERE "marketId"=$1) AS audits',[winner.marketId]);assert.deepEqual(counts.rows[0],{snapshots:1,audits:1});
  const again=await ingestLocalHour(clients[1],conflictSlot,{execute:true});assert.equal(again.snapshotId,winner.snapshotId);assert.equal(again.reused,true);
  revision3[0].reputation=revision4[0].reputation;
 }finally{pauseA.release();pauseA.restore();}
 console.log('PASS overlapping conflicting service ingestions: stale roster rejected, one snapshot/audit, replay stable');

 // Pause the actual service inside its transaction, immediately before finalization.
 const finalSlot='2026-10-17T07:00:00Z', extra='99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa',extraImmediate='99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await db.query('INSERT INTO users(id,name,email,password_hash,updated_at) VALUES($1,\'Unapproved synthetic\',\'not-enrolled@example.invalid\',\'synthetic\',now()),($2,\'Unapproved synthetic\',\'not-enrolled2@example.invalid\',\'synthetic\',now())',[extra,extraImmediate]);
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa',finalSlot,'2026-10-17T08:00:00Z',JSON.stringify(revision3),'ignored']);
 await clients[1].query("SET statement_timeout='15s'");
 // Disposable-only trigger holds one attack at an observed advisory lock until commit.
 await db.query(`CREATE FUNCTION b22_guard.measurement_race_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId"='99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa' THEN PERFORM pg_advisory_xact_lock(77665544); END IF; RETURN NEW; END $$`);
 await db.query('CREATE TRIGGER "A_B22Test_measurement_gate" BEFORE INSERT ON "V2SnapshotMeasurement" FOR EACH ROW EXECUTE FUNCTION b22_guard.measurement_race_gate()');
 await db.query('SELECT pg_advisory_lock(77665544)');
 const pauseFinal=pauseQuery(clients[0],q=>typeof q==='string'&&q.startsWith('UPDATE "V2Snapshot" SET status='));
 try{
  const active=ingestLocalHour(clients[0],finalSlot,{execute:true});
  const args=await pauseFinal.reached, pendingSnapshot=args[1][0], pendingMarket=marketId('hourly','HOURLY','2026-10-17T07:00:00.000Z','2026-10-17T08:00:00.000Z');
  await assert.rejects(clients[1].query('INSERT INTO "V2SnapshotMeasurement"("snapshotId","marketId","userId","productionWh","consumptionWh") VALUES($1,$2,$3,1,0)',[pendingSnapshot,pendingMarket,extraImmediate]),e=>e.code==='P0001'&&e.message==='snapshot does not exist');
  const attack=clients[1].query('INSERT INTO "V2SnapshotMeasurement"("snapshotId","marketId","userId","productionWh","consumptionWh") VALUES($1,$2,$3,1,0)',[pendingSnapshot,pendingMarket,extra]).then(value=>({value}),error=>({error}));
  await waitForLock(db,clients[1].processID); // Actual test gate lock observed, not a timing guess.
  pauseFinal.release();const final=await active;await db.query('SELECT pg_advisory_unlock(77665544)');const rejected=await attack;
  assert.equal(rejected.error?.code,'P0001');assert.equal(rejected.error?.message,'measurements require pending snapshot');assert.equal(final.snapshotId,pendingSnapshot);
  const verified=await inspectHistoricalHour(clients[0],finalSlot);assert.equal(verified.state,'FINALIZED');assert.equal(verified.snapshots.length,1);assert.equal(verified.snapshots[0].measurementCount,revision3.length);assert.equal(verified.snapshots[0].payloadHash,final.payloadHash);
  const actual=await db.query('SELECT "userId"::text AS id FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1 ORDER BY "userId"',[final.snapshotId]);assert.deepEqual(actual.rows.map(r=>r.id),revision3.map(u=>u.userId).sort());
  const auditCount=await db.query('SELECT count(*)::int AS n FROM "B22Ingestion" WHERE "snapshotId"=$1 AND "payloadHash"=$2',[final.snapshotId,final.payloadHash]);assert.equal(auditCount.rows[0].n,1);
 }finally{pauseFinal.release();pauseFinal.restore();await db.query('SELECT pg_advisory_unlock(77665544)');await clients[1].query('RESET statement_timeout');}
 console.log('PASS B22-A finalization versus unauthorized measurement: invisible draft and locked attempt rejected, set/hash/audit intact');
 // Test-only subprocess substitution emulates an unsupported generator release.
 const upgradeSlot='2026-10-17T06:00:00Z';
 await rosterClient.query('INSERT INTO "B22HourlyRegistry"(id,"intervalStart","intervalEnd",profiles,"approvedBy",revision) VALUES($1,$2,$3,$4,$5,1)',['44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa',upgradeSlot,'2026-10-17T07:00:00Z',JSON.stringify(revision3),'ignored']);
 const archivedBefore=await inspectHistoricalHour(clients[0],finalSlot);const auditBefore=(await db.query('SELECT to_jsonb(i) AS item FROM "B22Ingestion" i WHERE i."snapshotId"=$1',[archivedBefore.snapshots[0].snapshotId])).rows[0].item;
 const realSpawn=childProcess.spawnSync;
 try{
  childProcess.spawnSync=()=>{throw Error('generator must not run during historical replay');};syncBuiltinESMExports();
  const old=await ingestLocalHour(clients[0],finalSlot,{execute:true});assert.equal(old.reused,true);assert.equal(old.snapshotId,archivedBefore.snapshots[0].snapshotId);assert.equal(old.payloadHash,archivedBefore.snapshots[0].payloadHash);
  childProcess.spawnSync=(program,args,opts)=>{const out=realSpawn(program,args,opts);if(out.status===0&&args.includes('generate-snapshot')){const folder=args[args.indexOf('--output-dir')+1],slot=args[args.indexOf('--time-slot')+1],path=`${folder}/energy_snapshot_${slot.slice(0,13)}.json`;const data=JSON.parse(fs.readFileSync(path,'utf8'));data.generatorVersion='9.0.0';fs.writeFileSync(path,JSON.stringify(data));}return out;};syncBuiltinESMExports();
  await assert.rejects(ingestLocalHour(clients[0],upgradeSlot,{execute:true}),/Unapproved simulation source\/version/);
 }finally{childProcess.spawnSync=realSpawn;syncBuiltinESMExports();}
 const auditAfter=(await db.query('SELECT to_jsonb(i) AS item FROM "B22Ingestion" i WHERE i."snapshotId"=$1',[archivedBefore.snapshots[0].snapshotId])).rows[0].item;assert.deepEqual(auditAfter,auditBefore);
 const upgradeMarket=marketId('hourly','HOURLY','2026-10-17T06:00:00.000Z','2026-10-17T07:00:00.000Z');const noUpgrade=await db.query('SELECT count(*)::int AS n FROM "V2Snapshot" WHERE "marketId"=$1',[upgradeMarket]);assert.equal(noUpgrade.rows[0].n,0);
 console.log('PASS test-substituted unsupported generator version rejected; archived replay did not execute generator');
 console.log('PASS B22-A controlled generator, approved roster, rollback, finalized measurements, concurrent retry, immutable facts, committed correction and no plans/intents');
} finally {await Promise.allSettled([owner.end(),rosterClient.end(),...clients.map(c=>c.end())]);}
