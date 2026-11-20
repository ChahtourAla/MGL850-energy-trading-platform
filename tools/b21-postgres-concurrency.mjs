import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
const require=createRequire(new URL('../apps/backend/package.json',import.meta.url));
const {Client}=require('pg');
const url=process.env.B21_TEST_DATABASE_URL;
if(!url)throw Error('B21_TEST_DATABASE_URL is required; DATABASE_URL is never used');
const target=new URL(url);
if(!['127.0.0.1','localhost'].includes(target.hostname)||!['/b21_fresh_review','/b21_baseline_review'].includes(target.pathname)||target.username!=='b21test')throw Error('Refusing non-B21 test target');
const clients=[new Client({connectionString:url}),new Client({connectionString:url})];
try {
 await Promise.all(clients.map(c=>c.connect()));
 for(const c of clients){const r=await c.query("SELECT current_database() AS db, EXISTS(SELECT 1 FROM b21_guard.b21_owned_test_marker WHERE marker='mgl850-b21-review-f605e66-20261119') AS owned");if(!['b21_fresh_review','b21_baseline_review'].includes(r.rows[0].db)||!r.rows[0].owned)throw Error('Missing B21 ownership marker');}
 const sql=`INSERT INTO "V2Market" (id,namespace,mode,"intervalStart","intervalEnd","schemaVersion","configVersion","updatedAt") VALUES ($1,$2,'SIMULATION','2026-11-19 01:00Z','2026-11-19 02:00Z','2.0.0','1',now())`;
 const id='0x'+randomBytes(32).toString('hex');
 const namespace='simulation:concurrency_'+randomBytes(8).toString('hex');
 const buyer=randomUUID(), seller=randomUUID(), snap=randomUUID(), allocation='0x'+randomBytes(32).toString('hex'), intent='0x'+randomBytes(32).toString('hex');
 const addr=x=>'0x'+x.repeat(40), hash=x=>'0x'+x.repeat(64);
 async function waitForBlockedSession() {
  for(let n=0;n<100;n++) {
   const observed=await clients[0].query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[clients[1].processID]);
   if(observed.rows[0]?.wait_event_type==='Lock')return;
   await clients[0].query('SELECT pg_sleep(0.02)');
  }
  throw Error('Concurrent session did not block on the expected lock');
 }

 async function race(label,query,values,otherValues=values) {
  await clients[0].query('BEGIN');
  await clients[0].query(query,values);
  const competing=clients[1].query(query,otherValues).then(()=>({ok:true}),error=>({error}));
  await waitForBlockedSession();
  await clients[0].query('COMMIT');
  const rejected=await competing; assert.equal(rejected.error?.code,'23505');
  console.log(`PASS ${label}: lock observed and duplicate rejected`);
 }
 await race('concurrent duplicate market',sql,[id,namespace]);
 await clients[0].query('INSERT INTO users (id,name,email,password_hash,updated_at) VALUES ($1,$2,$3,$4,now()),($5,$6,$7,$4,now())',[buyer,'test buyer',buyer+'@example.invalid','synthetic',seller,'test seller',seller+'@example.invalid']);
 await clients[0].query(`INSERT INTO "V2Snapshot" (id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status,"finalizedAt",finalizer) VALUES ($1,$2,'2026-11-19 01:00Z','2026-11-19 02:00Z','test','1',$3,$4,'2.0.0',2,2,'{}',now(),'FINALIZED',now(),'test')`,[snap,id,hash('1'),hash('2')]);
 await race('concurrent duplicate allocation',`INSERT INTO "V2Allocation" (id,"marketId","snapshotId","buyerId","sellerId","buyerAddress","sellerAddress","quantityWh","unitPriceMicrousdPerKwh","amountBaseUnits",remainder,"algorithmVersion","pricingVersion","planVersion") VALUES ($1,$2,$3,$4,$5,$6,$7,1000,1,1,0,'test','test','1')`,[allocation,id,snap,buyer,seller,addr('1'),addr('2')]);
 await race('concurrent duplicate payment intent',`INSERT INTO "V2SettlementIntent" (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits","updatedAt") VALUES ($1,$2,$3,296,$4,$5,1,now())`,[intent,allocation,id,addr('3'),addr('4')]);
 const event='0x'+randomBytes(32).toString('hex');
 const evidenceSql=`INSERT INTO "V2SettlementEvidence" (id,"settlementId","chainId","contractAddress","tokenAddress","txHash","receiptStatus","logIndex","buyerAddress","sellerAddress","amountBaseUnits","confirmedAt","verificationStatus") VALUES ($1,$2,296,$3,$4,$5,'SUCCESS',0,$6,$7,1,now(),'VERIFIED')`;
 await race('concurrent duplicate verified evidence',evidenceSql,[randomUUID(),intent,addr('4'),addr('3'),event,addr('1'),addr('2')],[randomUUID(),intent,addr('4'),addr('3'),event,addr('1'),addr('2')]);
 // Competing financial mutation must be rejected even while the other session references the snapshot.
 await clients[0].query('BEGIN');
 await clients[0].query('SELECT 1 FROM "V2Snapshot" WHERE id=$1 FOR UPDATE',[snap]);
 const mutation=clients[1].query('UPDATE "V2Snapshot" SET "payloadHash"=$2 WHERE id=$1',[snap,hash('9')]);
 await waitForBlockedSession();
 await clients[0].query('COMMIT');
 await assert.rejects(mutation);console.log('PASS concurrent finalized snapshot mutation rejected');
 const market2='0x'+randomBytes(32).toString('hex'), snap2=randomUUID(), allocation2='0x'+randomBytes(32).toString('hex');
 await clients[0].query(sql,[market2,'simulation:finalize_'+randomBytes(8).toString('hex')]);
 await clients[0].query(`INSERT INTO "V2Snapshot" (id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status) VALUES ($1,$2,'2026-11-19 01:00Z','2026-11-19 02:00Z','test','1',$3,$4,'2.0.0',2,2,'{}',now(),'PENDING')`,[snap2,market2,hash('1'),hash('2')]);
 await clients[0].query('BEGIN');
 await clients[0].query(`UPDATE "V2Snapshot" SET status='FINALIZED',"finalizedAt"=now(),finalizer='test' WHERE id=$1`,[snap2]);
 const allocationDuringFinalization=clients[1].query(`INSERT INTO "V2Allocation" (id,"marketId","snapshotId","buyerId","sellerId","buyerAddress","sellerAddress","quantityWh","unitPriceMicrousdPerKwh","amountBaseUnits",remainder,"algorithmVersion","pricingVersion","planVersion") VALUES ($1,$2,$3,$4,$5,$6,$7,1000,1,1,0,'test','test','1')`,[allocation2,market2,snap2,buyer,seller,addr('1'),addr('2')]);
 await waitForBlockedSession();
 await clients[0].query('COMMIT');
 await allocationDuringFinalization;console.log('PASS concurrent finalization and allocation serialized');
 await clients[0].query('BEGIN');
 await clients[0].query(`UPDATE "V2SettlementIntent" SET status='CONFIRMED' WHERE id=$1`,[intent]);
 await clients[0].query('COMMIT');
 await clients[0].query('BEGIN');
 await clients[0].query(`UPDATE "V2SettlementIntent" SET status='PROJECTED' WHERE id=$1`,[intent]);
 await clients[0].query('COMMIT');
 console.log('PASS verified evidence permits CONFIRMED and PROJECTED commits');
 // Corrections are committed separately. Measurement-level correction coverage
 // is pending a snapshot-scoped measurement design.
 const beforeSnapshot=(await clients[0].query('SELECT to_jsonb(s) AS value FROM "V2Snapshot" s WHERE id=$1',[snap])).rows[0].value;
 const beforeAllocation=(await clients[0].query('SELECT to_jsonb(a) AS value FROM "V2Allocation" a WHERE id=$1',[allocation])).rows[0].value;
 const correction=randomUUID();
 await clients[0].query('BEGIN');
 await clients[0].query(`INSERT INTO "V2Snapshot" (id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status,"supersedesId") VALUES ($1,$2,'2026-11-19 01:00Z','2026-11-19 02:00Z','test','2',$3,$4,'2.0.0',2,2,'{}',now(),'PENDING',$5)`,[correction,id,hash('1'),hash('3'),snap]);
 await clients[0].query(`UPDATE "V2Snapshot" SET status='FINALIZED',"finalizedAt"=now(),finalizer='test' WHERE id=$1`,[correction]);
 await clients[0].query('COMMIT');
 assert.equal((await clients[0].query('SELECT status FROM "V2Snapshot" WHERE id=$1',[correction])).rows[0].status,'FINALIZED');
 assert.deepEqual((await clients[0].query('SELECT to_jsonb(s) AS value FROM "V2Snapshot" s WHERE id=$1',[snap])).rows[0].value,beforeSnapshot);
 assert.deepEqual((await clients[0].query('SELECT to_jsonb(a) AS value FROM "V2Allocation" a WHERE id=$1',[allocation])).rows[0].value,beforeAllocation);
 console.log('PASS committed superseding snapshot preserves original snapshot and allocation');

 for(const status of ['CONFIRMED','PROJECTED']) {
  const noEvidenceAlloc='0x'+randomBytes(32).toString('hex'), noEvidenceIntent='0x'+randomBytes(32).toString('hex');
  await clients[0].query('BEGIN');
  await clients[0].query(`INSERT INTO "V2Allocation" (id,"marketId","snapshotId","buyerId","sellerId","buyerAddress","sellerAddress","quantityWh","unitPriceMicrousdPerKwh","amountBaseUnits",remainder,"algorithmVersion","pricingVersion","planVersion") VALUES ($1,$2,$3,$4,$5,$6,$7,2000,1,2,0,'test','test','1')`,[noEvidenceAlloc,id,snap,buyer,seller,addr('1'),addr('2')]);
  await clients[0].query(`INSERT INTO "V2SettlementIntent" (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt") VALUES ($1,$2,$3,296,$4,$5,2,$6,now())`,[noEvidenceIntent,noEvidenceAlloc,id,addr('3'),addr('4'),status]);
  await assert.rejects(clients[0].query('COMMIT'), e=>e.code==='P0001');
  const absent=await clients[0].query('SELECT 1 FROM "V2SettlementIntent" WHERE id=$1',[noEvidenceIntent]);assert.equal(absent.rowCount,0);
  console.log(`PASS deferred COMMIT rejects ${status} without verified evidence`);
 }




} finally {await Promise.allSettled(clients.map(c=>c.end()));}
