const testClocks=new WeakMap();
/** Test clocks require the authenticated, marker-protected disposable worker. */
export async function createDisposableTestClock(client,initial){
 await assertB26Worker(client);
 if(!(initial instanceof Date)||!Number.isFinite(initial.getTime())||initial.getTime()>Date.now())throw Error('Invalid disposable clock');
 const state={client,ms:initial.getTime()};
 const clock=Object.freeze({advanceTo(value){if(!(value instanceof Date)||!Number.isFinite(value.getTime())||value.getTime()<state.ms||value.getTime()>Date.now())throw Error('Invalid disposable clock advance');state.ms=value.getTime();}});
 testClocks.set(clock,state);return clock;
}
function schedulerNow(client,clock){
 if(!clock)return new Date();
 const state=testClocks.get(clock);
 if(!state||state.client!==client)throw Error('Unapproved disposable clock');
 return new Date(state.ms);
}

/** A bounded tick discovers closed hours and delegates each to the fenced worker. */
import {closedHours} from './b26-utc-hours.mjs';
import {assertB26Worker,ensureMarketRun} from './b26-market-run.mjs';
import {processMarketRun} from './b26-market-worker.mjs';

export async function runSchedulerTick({coordinationClient,matchingClient,from,workerId,graceMs=0,limit=24,localPayments,testClock}) {
 const intervals=closedHours({from,now:schedulerNow(coordinationClient,testClock),graceMs,limit});
 const results=[];
 for(const interval of intervals){
  const run=await ensureMarketRun(coordinationClient,{start:interval.start});
  try { results.push({intervalStart:interval.start.toISOString(),...await processMarketRun({coordinationClient,matchingClient,run,workerId,localPayments})}); }
  catch { results.push({intervalStart:interval.start.toISOString(),state:'BLOCKED',runId:run.id,reason:'PROCESSING_ERROR'}); }
 }
 await coordinationClient.query('SELECT b26_record_tick($1,$2)',[workerId,results.length]);
 return results;
}

/** Claim a bounded administrative request under the existing fenced worker identity. */
export async function processControlRequest({coordinationClient,matchingClient,workerId,localPayments,graceMs=0}) {
 const q=(await coordinationClient.query('SELECT b26_claim_control($1,300) AS request',[workerId])).rows[0].request;
 if(!q)return null;
 const from=new Date(q.targetStart),hours=q.kind==='RECOVER'?1:(Date.parse(q.intervalEnd)-from.getTime())/3600000;
 if(!Number.isSafeInteger(hours)||hours<1||hours>24)throw Error('Invalid B26 control request');
 const results=await runSchedulerTick({coordinationClient,matchingClient,from,workerId,localPayments,graceMs,limit:hours});
 if(results.length!==hours||results.some(x=>x.state==='DEFERRED'||x.reason==='PROCESSING_ERROR'))return {state:'DEFERRED',requestId:q.id};
 await coordinationClient.query('SELECT b26_complete_control($1,$2,$3)',[q.id,workerId,String(q.fence)]);
 return {state:'DONE',requestId:q.id};
}

/** Retry expired leases and due backoff without waiting for the full catch-up
 * cursor to reach the present. Every candidate is claimed and fenced again. */
export async function processDueMarketRuns({coordinationClient,matchingClient,from,workerId,localPayments,graceMs=0,testClock}) {
 const until=new Date(schedulerNow(coordinationClient,testClock).getTime()-graceMs);
 if(until<=from)return [];
 const due=await coordinationClient.query('SELECT b26_due_runs($1,$2,$3) AS run',[from,until,8]);
 const results=[];
 for(const row of due.rows){
  try{results.push(await processMarketRun({coordinationClient,matchingClient,run:row.run,workerId,localPayments}));}
  catch{results.push({state:'BLOCKED',runId:row.run.id,reason:'PROCESSING_ERROR'});}
 }
 return results;
}

/** Re-scan closed intervals after each bounded pass so missed or delayed data can be retried.
 * Caller owns process startup, authenticated clients and an AbortSignal.
 */
export async function runScheduler({coordinationClient,matchingClient,from,workerId,localPayments,graceMs=0,limit=24,pollMs=30000,signal,onResult,testClock}) {
 if(!(from instanceof Date)||!Number.isSafeInteger(pollMs)||pollMs<1000||pollMs>3600000||!signal)throw Error('Invalid scheduler configuration');
 let cursor=from;
 while(!signal.aborted){
  await processControlRequest({coordinationClient,matchingClient,workerId,localPayments,graceMs});
  const results=await runSchedulerTick({coordinationClient,matchingClient,from:cursor,workerId,localPayments,graceMs,limit,testClock});
  if(!signal.aborted)await processDueMarketRuns({coordinationClient,matchingClient,from,workerId,localPayments,graceMs,testClock});
  if(onResult)for(const result of results)onResult(result);
  if(results.length===limit){cursor=new Date(Date.parse(results[results.length-1].intervalStart)+3600000);continue;}
  cursor=from;
  await new Promise(resolve=>{
   if(signal.aborted){resolve();return;}
   const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
   const timer=setTimeout(done,pollMs);
   signal.addEventListener('abort',done,{once:true});
  });
 }
}
