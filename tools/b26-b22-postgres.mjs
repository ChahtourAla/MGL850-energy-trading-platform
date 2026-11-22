import pg from '../apps/backend/node_modules/pg/lib/index.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ensureMarketRun,claimMarketRun} from '../apps/backend/scripts/b26-market-run.mjs';
import {runSchedulerTick,processControlRequest} from '../apps/backend/scripts/b26-market-scheduler.mjs';
import {previewMarketRun} from '../apps/backend/scripts/b26-dry-run.mjs';
const owner=new pg.Client({connectionString:process.env.B22_TEST_DATABASE_URL});
const adminUrl=new URL(process.env.B26_WORKER_DATABASE_URL);adminUrl.username='b26_admin';
const admin=new pg.Client({connectionString:adminUrl.toString()});
const coord=new pg.Client({connectionString:process.env.B26_WORKER_DATABASE_URL});
const match=new pg.Client({connectionString:process.env.B22_MATCH_DATABASE_URL});
await Promise.all([coord.connect(),match.connect(),owner.connect(),admin.connect()]);
try {
 const before=(await owner.query('SELECT (SELECT count(*)::int FROM "V2AllocationPlan") plans,(SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "B24AuthorizationReservation") reservations')).rows[0];
 const preview=await previewMarketRun(match,'2026-10-03T12:00:00Z');assert.equal(preview.state,'MATCHED');assert.equal(preview.financialWrites,false);
 const after=(await owner.query('SELECT (SELECT count(*)::int FROM "V2AllocationPlan") plans,(SELECT count(*)::int FROM "V2SettlementIntent") intents,(SELECT count(*)::int FROM "B24AuthorizationReservation") reservations')).rows[0];assert.deepEqual(after,before);
 const missingStart=new Date('2020-01-03T00:00:00Z');
 const missing=await runSchedulerTick({coordinationClient:coord,matchingClient:match,from:missingStart,workerId:randomUUID(),limit:1});assert.equal(missing[0].state,'WAITING_FOR_DATA');
 const missingRun=(await owner.query('SELECT status,"nextRetryAt" FROM "B26MarketRun" WHERE id=$1',[missing[0].runId])).rows[0];assert.equal(missingRun.status,'WAITING_FOR_DATA');assert.ok(missingRun.nextRetryAt);
 const deferred=await runSchedulerTick({coordinationClient:coord,matchingClient:match,from:missingStart,workerId:randomUUID(),limit:1});assert.equal(deferred[0].state,'DEFERRED');
 const run=await ensureMarketRun(coord,{start:new Date('2026-10-03T12:00:00Z')});
 const results=await runSchedulerTick({coordinationClient:coord,matchingClient:match,from:new Date('2026-10-03T12:00:00Z'),workerId:randomUUID(),limit:1});
 assert.equal(results.length,1);const result=results[0];
 assert.equal(result.state,'MATCHED');assert.equal(result.allocations,1);
 assert.equal(result.run.status,'MATCHED');assert.equal(result.run.id,run.id);assert.ok(result.run.snapshotHash);assert.ok(result.run.planId);
 const again=await runSchedulerTick({coordinationClient:coord,matchingClient:match,from:new Date('2026-10-03T12:00:00Z'),workerId:randomUUID(),limit:1});
 assert.equal(again[0].state,'MATCHED');assert.equal(again[0].run.id,run.id);

 // Opt-in long-running worker test. This pauses a genuine B22 snapshot read
 // for more than the normal 60-second B26 lease. No financial operations occur.
 if(process.env.B26_TEST_LONG_LEASE==='1'){
  const originalQuery=match.query.bind(match);
  let signalPaused;
  const paused=new Promise(resolve=>{signalPaused=resolve;});
  let delayed=false;
  const slowWorker=randomUUID();
  const competitor=new pg.Client({connectionString:process.env.B26_WORKER_DATABASE_URL});
  await competitor.connect();
  let running;
  try{
   match.query=async (...args)=>{
    if(!delayed&&typeof args[0]==='string'&&args[0].includes('SELECT current_database() AS name')){
     delayed=true;
     signalPaused();
     await new Promise(resolve=>setTimeout(resolve,65000));
    }
    return originalQuery(...args);
   };
   running=runSchedulerTick({coordinationClient:coord,matchingClient:match,from:new Date('2026-10-03T12:00:00Z'),workerId:slowWorker,limit:1});
   await paused;
   const before=(await owner.query('SELECT fence FROM "B26MarketRun" WHERE id=$1',[run.id])).rows[0];
   await new Promise(resolve=>setTimeout(resolve,62000));
   const active=(await owner.query('SELECT "workerId",fence,"leaseUntil">clock_timestamp() AS active FROM "B26MarketRun" WHERE id=$1',[run.id])).rows[0];
   assert.equal(active.workerId,slowWorker,'B26 worker lost ownership while matching was delayed');
   assert.equal(active.fence,before.fence,'B26 fencing token unexpectedly changed');
   assert.equal(active.active,true,'B26 lease expired during a long matching operation');
   assert.equal(await claimMarketRun(competitor,{runId:run.id,workerId:randomUUID(),leaseSeconds:60}),null,'A competing worker claimed an active run');
   const completed=await running;
   assert.equal(completed[0].state,'MATCHED');
   assert.equal(completed[0].run.id,run.id);
   console.log('PASS B26 real worker lease survived >60-second B22 matching delay; competing claim blocked');
  }finally{
   match.query=originalQuery;
   if(running)await running.catch(()=>{});
   await competitor.end();
  }
 }

 const requestId=randomUUID();await admin.query('SELECT b26_request_control($1,$2,$3,$4,$5)',[requestId,'CATCH_UP',null,new Date('2026-10-03T12:00:00Z'),new Date('2026-10-03T13:00:00Z')]);
 const control=await processControlRequest({coordinationClient:coord,matchingClient:match,workerId:randomUUID()});assert.deepEqual(control,{state:'DONE',requestId});
 assert.equal((await owner.query('SELECT status FROM "B26ControlRequest" WHERE id=$1',[requestId])).rows[0].status,'DONE');
 console.log('PASS B26 scheduler verifies genuine finalized B22 snapshot, reuses authoritative plan and rejects duplicate claim');
} finally {await Promise.all([coord.end(),match.end(),owner.end(),admin.end()]);}
