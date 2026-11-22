/** Child worker for the disposable restart test; no wallet key or provider is passed. */
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {ensureMarketRun,claimMarketRun} from '../apps/backend/scripts/b26-market-run.mjs';
import {runSchedulerTick,runScheduler} from '../apps/backend/scripts/b26-market-scheduler.mjs';
const coord=new pg.Client({connectionString:process.env.B26_WORKER_DATABASE_URL});
const match=new pg.Client({connectionString:process.env.B22_MATCH_DATABASE_URL});
await Promise.all([coord.connect(),match.connect()]);
try{
 const from=new Date('2026-10-03T00:00:00Z');
 if(process.argv[2]==='claim'){
  const first=await runSchedulerTick({coordinationClient:coord,matchingClient:match,from,workerId:randomUUID(),limit:3});
  if(first.length!==3||first.some(x=>x.reason==='PROCESSING_ERROR'))throw Error('Initial scheduler intervals failed');
  const run=await ensureMarketRun(coord,{start:new Date(from.getTime()+3*3600000)});
  const claim=await claimMarketRun(coord,{runId:run.id,workerId:randomUUID(),leaseSeconds:1});
  if(!claim)throw Error('Unable to claim restart fixture');
  process.send?.({phase:'claimed',runId:run.id,fence:claim.fence,processed:first.length});
  await new Promise(()=>{});
 }else if(process.argv[2]==='recover'){
  const results=[],stop=new AbortController();
  await runScheduler({coordinationClient:coord,matchingClient:match,from,workerId:randomUUID(),limit:24,signal:stop.signal,onResult:result=>{results.push(result);if(results.length===24)stop.abort();}});
  process.send?.({phase:'recovered',count:results.length,errors:results.filter(x=>x.reason==='PROCESSING_ERROR').length});
 }else throw Error('Unknown restart test phase');
} finally {await Promise.allSettled([coord.end(),match.end()]);}
