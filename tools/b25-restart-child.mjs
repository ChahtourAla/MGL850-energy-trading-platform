/** Disposable-process crash fixture. Never receives or exports private keys. */
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {JsonRpcProvider} from '../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {restoreLocalChainSession} from '../apps/backend/scripts/b24-local-chain-session.mjs';
import {createLocalOperatorRegistry,executeLocalSettlement} from '../apps/backend/scripts/b25-settlement-executor.mjs';
import {recoverLocalSettlement} from '../apps/backend/scripts/b25-settlement-recovery.mjs';
const url=new URL(process.env.B25_LOCAL_RPC_URL??'');
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Only loopback local RPC is allowed');
for(const name of ['B24_PREFLIGHT_DATABASE_URL','B25_EXECUTOR_DATABASE_URL','B25_VERIFIER_DATABASE_URL']){const u=new URL(process.env[name]??'');if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('Only disposable PostgreSQL is allowed');}
const provider=new JsonRpcProvider(url.href),preflight=new pg.Client({connectionString:process.env.B24_PREFLIGHT_DATABASE_URL}),client=new pg.Client({connectionString:process.env[process.env.B25_CHILD_ACTION?.startsWith('recover')?'B25_VERIFIER_DATABASE_URL':'B25_EXECUTOR_DATABASE_URL']});
await Promise.all([client.connect(),preflight.connect()]);
try{
 const session=await restoreLocalChainSession(preflight,{sessionId:process.env.B25_SESSION_ID,provider});
 if(process.env.B25_CHILD_ACTION?.startsWith('recover')){
  if(process.env.B25_CHILD_ACTION==='recover-crash'){const query=client.query.bind(client);client.query=async(...args)=>{const result=await query(...args);if(typeof args[0]==='string'&&args[0].includes('b25_record_outcome'))process.exit(78);return result;};}
  const result=await recoverLocalSettlement({client,provider,session,attemptId:process.env.B25_ATTEMPT_ID});
  process.send?.({event:'result',state:result.state,reason:result.reason??null});
 }else{
  const registry=await createLocalOperatorRegistry({client,provider});
  process.send?.({event:'operator',address:registry.address});
  await new Promise(resolve=>process.once('message',resolve));
  const query=client.query.bind(client);
  client.query=async(...args)=>{const result=await query(...args);const sql=args[0];
   if(typeof sql==='string'&&((process.env.B25_CRASH_POINT==='prepared'&&sql.includes('b25_prepare_local_attempt'))||(process.env.B25_CRASH_POINT==='handoff'&&sql.includes('b25_authorize_handoff'))))process.exit(77);
   return result;};
  if(process.env.B25_CRASH_POINT==='broadcast'){
   const broadcast=provider.broadcastTransaction.bind(provider);
   provider.broadcastTransaction=async raw=>{await broadcast(raw);process.exit(77);};
  }
  if(process.env.B25_CRASH_POINT==='revert'){
   const broadcast=provider.broadcastTransaction.bind(provider);
   provider.broadcastTransaction=async raw=>{
    process.send?.({event:'before-revert-broadcast'});
    await new Promise(resolve=>process.once('message',resolve));
    try{await broadcast(raw);}catch{/* A locally mined revert may be returned as an RPC error. */}
    process.exit(77);
   };
  }
  await executeLocalSettlement({client,preflightClient:preflight,provider,session,registry,intentId:process.env.B25_INTENT_ID});
  throw Error('Expected crash point was not reached');
 }
}finally{await Promise.allSettled([client.end(),preflight.end()]);provider.destroy();}
