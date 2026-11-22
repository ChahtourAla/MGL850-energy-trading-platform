/** Disposable-only scheduler entrypoint; payment authorization is not bootstrapped here. */
import pg from '../node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {requireHour} from './b11-pipeline-core.mjs';
import {assertB26Worker} from './b26-market-run.mjs';
import {runScheduler} from './b26-market-scheduler.mjs';
import {createSupervisorIpcClient} from './b26-supervisor-ipc.mjs';
const start=requireHour(process.env.B26_START_UTC);
if(process.env.B26_OFFLINE_SCHEDULER!=='1')throw Error('B26 offline scheduler must be explicitly enabled');
if(!['MATCHING_ONLY','SUPERVISED_TEST'].includes(process.env.B26_SCHEDULER_MODE))throw Error('B26 explicit scheduler mode required');
const supervisor=process.env.B26_SCHEDULER_MODE==='SUPERVISED_TEST'?createSupervisorIpcClient():null;
console.log(JSON.stringify({component:'b26-scheduler',event:'STARTED',mode:process.env.B26_SCHEDULER_MODE,simulationOnly:true}));
function localUrl(value,role){
 if(!value)throw Error('B26 disposable database configuration missing');
 let url;try{url=new URL(value);}catch{throw Error('B26 disposable database configuration invalid');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/b22_disposable_review'||decodeURIComponent(url.username)!==role)throw Error('Refusing non-disposable B26 database');
 return value;
}
const coordUrl=localUrl(process.env.B26_WORKER_DATABASE_URL,'b26_worker');
const matcherUrl=localUrl(process.env.B22_MATCH_DATABASE_URL,'b22_match');
const signal=new AbortController();
process.once('SIGINT',()=>signal.abort());process.once('SIGTERM',()=>signal.abort());
async function delay(ms){await new Promise(resolve=>{if(signal.signal.aborted){resolve();return;}const done=()=>{clearTimeout(timer);signal.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal.signal.addEventListener('abort',done,{once:true});});}
let failures=0;
while(!signal.signal.aborted){
 const coord=new pg.Client({connectionString:coordUrl,connectionTimeoutMillis:3000});
 const matcher=new pg.Client({connectionString:matcherUrl,connectionTimeoutMillis:3000});
 try{
  await Promise.all([coord.connect(),matcher.connect()]);await assertB26Worker(coord);
  await runScheduler({coordinationClient:coord,matchingClient:matcher,from:new Date(start),workerId:randomUUID(),signal:signal.signal,localPayments:supervisor?{supervisor,remoteSupervisor:true}:undefined,onResult:result=>console.log(JSON.stringify({component:'b26-scheduler',event:'MARKET_RUN',intervalStart:result.intervalStart,runId:result.runId??result.run?.id??null,state:result.state,reason:result.reason??null,transactionHashes:(result.outcomes??[]).map(x=>x.transactionHash).filter(x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x))}))});
 }catch{
  // Do not log connection URLs, credentials or caller-supplied exception text.
  failures=Math.min(failures+1,6);console.error(JSON.stringify({component:'b26-scheduler',event:'CONNECTION_OR_WORKER_FAILURE',retrySeconds:Math.min(60,2**failures)}));
 }finally{await Promise.allSettled([coord.end(),matcher.end()]);}
 if(!signal.signal.aborted)await delay(Math.min(60000,1000*2**failures));
}
supervisor?.close();
