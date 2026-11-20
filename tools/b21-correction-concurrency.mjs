import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {snapshotHash, matchingInputHash} from '../packages/shared/v2-identity.mjs';
const require=createRequire(new URL('../apps/backend/package.json',import.meta.url));
const {Client}=require('pg');const url=process.env.B21_CORRECTION_DATABASE_URL;if(!url)throw Error('B21_CORRECTION_DATABASE_URL required');
const target=new URL(url);if(target.hostname!=='127.0.0.1'||!['/b21_correction_test','/b21_correction_final2','/b21_correction_final3','/b21_fresh_review'].includes(target.pathname)||target.username!=='b21test')throw Error('unsafe target');
const clients=[new Client({connectionString:url}),new Client({connectionString:url})];
try {
 await Promise.all(clients.map(c=>c.connect()));
 for(const c of clients){const r=await c.query("SELECT current_database() AS db, EXISTS(SELECT 1 FROM b21_guard.marker WHERE id='mgl850-b21-correction') AS ok");assert.ok(['b21_correction_test','b21_correction_final2','b21_correction_final3','b21_fresh_review'].includes(r.rows[0].db));assert.equal(r.rows[0].ok,true);}
 async function waitLock(){for(let n=0;n<100;n++){const r=await clients[0].query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[clients[1].processID]);if(r.rows[0]?.wait_event_type==='Lock')return;await clients[0].query('SELECT pg_sleep(0.02)');}throw Error('no lock observed');}
 const market='0x'+randomBytes(32).toString('hex'),sid=randomUUID(),user=randomUUID(),user2=randomUUID(),plan1='0x'+randomBytes(32).toString('hex'),plan2='0x'+randomBytes(32).toString('hex'),config='0x'+'2'.repeat(64);
 const hash=snapshotHash(market,[{userId:user,productionWh:'1',consumptionWh:'0'}]);
 await clients[0].query('INSERT INTO users(id,name,email,password_hash,updated_at) VALUES ($1,$2,$3,$4,now()),($5,$2,$6,$4,now())',[user,'synthetic',user+'@example.invalid','test',user2,user2+'@example.invalid']);
 await clients[0].query(`INSERT INTO "V2Market"(id,namespace,mode,"intervalStart","intervalEnd","schemaVersion","configVersion","updatedAt") VALUES ($1,$2,'SIMULATION','2026-11-19 01:00Z','2026-11-19 02:00Z','2.0.0','1',now())`,[market,'simulation:race_'+randomBytes(5).toString('hex')]);
 await clients[0].query(`INSERT INTO "V2Snapshot"(id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status) VALUES ($1,$2,'2026-11-19 01:00Z','2026-11-19 02:00Z','test','1',$3,$4,'2.0.0',1,1,'{}',now(),'PENDING')`,[sid,market,config,hash]);
 await clients[0].query('INSERT INTO "V2SnapshotMeasurement" VALUES ($1,$2,$3,1,0)',[sid,market,user]);
 await clients[0].query('BEGIN');await clients[0].query(`UPDATE "V2Snapshot" SET status='FINALIZED',"finalizedAt"=now(),finalizer='test' WHERE id=$1`,[sid]);
 const competing=clients[1].query('INSERT INTO "V2SnapshotMeasurement" VALUES ($1,$2,$3,0,1)',[sid,market,user2]).then(()=>({ok:true}),error=>({error}));
 await waitLock();await clients[0].query('COMMIT');const result=await competing;assert.equal(result.error?.message,'measurements require pending snapshot');console.log('PASS finalized snapshot rejects concurrent late measurement after lock wait');
 const manifest={schemaVersion:'1.0.0',marketId:market,snapshotHash:hash,intervalStart:'2026-11-19T01:00:00.000Z',intervalEnd:'2026-11-19T02:00:00.000Z',algorithmVersion:'a',pricingPolicyVersion:'p',maximumDistanceKm:'10',scoringWeights:{quantity:'0.25',price:'0.25',distance:'0.25',reputation:'0.25'},participants:[{userId:user,timeSlot:'2026-11-19T01:00:00.000Z',productionWh:'1',consumptionWh:'0',marketRole:'SELLER',availableWh:'1',requiredWh:'0',energyType:'SOLAR',askPriceMicrousdPerKwh:'1',maxPriceMicrousdPerKwh:null,xKm:'0',yKm:'0',reputation:'50',preferredEnergyType:'ANY',evmAddress:'0x'+'2'.repeat(40)}]};
 for(const [id,version] of [[plan1,'v1'],[plan2,'v2']])await clients[0].query(`INSERT INTO "V2AllocationPlan"(id,"marketId","snapshotId","planVersion","manifestHash",manifest) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[id,market,sid,version,matchingInputHash(manifest),JSON.stringify(manifest)]);
 await clients[0].query('BEGIN');await clients[0].query(`UPDATE "V2AllocationPlan" SET status='AUTHORITATIVE' WHERE id=$1`,[plan1]);
 const competingPlan=clients[1].query(`UPDATE "V2AllocationPlan" SET status='AUTHORITATIVE' WHERE id=$1`,[plan2]).then(()=>({ok:true}),error=>({error}));
 await waitLock();await clients[0].query('COMMIT');const planResult=await competingPlan;assert.equal(planResult.error?.code,'23505');assert.equal(planResult.error?.constraint,'V2Plan_one_authoritative_per_market');console.log('PASS concurrent plan activation rejects second authoritative plan');
 for(const action of ['UPDATE','DELETE']) {
  const m='0x'+randomBytes(32).toString('hex'), sn=randomUUID(), u=randomUUID();
  const sh=snapshotHash(m,[{userId:u,productionWh:'1',consumptionWh:'0'}]);
  await clients[0].query('INSERT INTO users(id,name,email,password_hash,updated_at) VALUES ($1,$2,$3,$4,now())',[u,'synthetic',u+'@example.invalid','test']);
  await clients[0].query(`INSERT INTO "V2Market"(id,namespace,mode,"intervalStart","intervalEnd","schemaVersion","configVersion","updatedAt") VALUES ($1,$2,'SIMULATION','2026-11-19 01:00Z','2026-11-19 02:00Z','2.0.0','1',now())`,[m,'simulation:race_'+randomBytes(5).toString('hex')]);
  await clients[0].query(`INSERT INTO "V2Snapshot"(id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status) VALUES ($1,$2,'2026-11-19 01:00Z','2026-11-19 02:00Z','test','1',$3,$4,'2.0.0',1,1,'{}',now(),'PENDING')`,[sn,m,config,sh]);
  await clients[0].query('INSERT INTO "V2SnapshotMeasurement" VALUES ($1,$2,$3,1,0)',[sn,m,u]);
  await clients[0].query('BEGIN');await clients[0].query(`UPDATE "V2Snapshot" SET status='FINALIZED',"finalizedAt"=now(),finalizer='test' WHERE id=$1`,[sn]);
  const query=action==='UPDATE'?'UPDATE "V2SnapshotMeasurement" SET "productionWh"=2 WHERE "snapshotId"=$1':'DELETE FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1';
  const attempt=clients[1].query(query,[sn]).then(()=>({ok:true}),error=>({error}));
  await waitLock();await clients[0].query('COMMIT');const out=await attempt;assert.equal(out.error?.message,'measurements require pending snapshot');
  console.log(`PASS concurrent ${action} rejected after snapshot finalization`);
 }

} finally {await Promise.allSettled(clients.map(c=>c.end()));}
