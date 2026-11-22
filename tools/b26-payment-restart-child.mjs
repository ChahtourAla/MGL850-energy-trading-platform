/** Disposable B26 worker restart fixture. Private wallets never leave this process. */
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {JsonRpcProvider} from '../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {randomUUID} from 'node:crypto';
import {createEphemeralTestWalletRegistry} from '../apps/backend/scripts/b24-signing.mjs';
import {createLocalOperatorRegistry} from '../apps/backend/scripts/b25-settlement-executor.mjs';
import {restoreLocalChainSession} from '../apps/backend/scripts/b24-local-chain-session.mjs';
import {ensureMarketRun} from '../apps/backend/scripts/b26-market-run.mjs';
import {processMarketRun} from '../apps/backend/scripts/b26-market-worker.mjs';
let completed=false;
process.on('disconnect',()=>{if(!completed)process.exit(1);});
const rpc=new URL(process.env.B25_LOCAL_RPC_URL??'');
if(rpc.protocol!=='http:'||rpc.hostname!=='127.0.0.1')throw Error('Local RPC required');
const provider=new JsonRpcProvider(rpc.toString(),31337);
const names={coord:'B26_WORKER_DATABASE_URL',matcher:'B22_MATCH_DATABASE_URL',evaluator:'B24_EVALUATOR_DATABASE_URL',preflight:'B24_PREFLIGHT_DATABASE_URL',signer:'B24_SIGNER_DATABASE_URL',funder:'B24_FUNDING_DATABASE_URL',receiptVerifier:'B24_RECEIPT_DATABASE_URL',allowance:'B24_ALLOWANCE_DATABASE_URL',executor:'B25_EXECUTOR_DATABASE_URL',verifier:'B25_VERIFIER_DATABASE_URL',reporter:'B25_REPORTER_DATABASE_URL'};
const clients={};
for(const [name,env] of Object.entries(names)){
 const value=process.env[env];if(!value)throw Error('Disposable database configuration missing');
 const u=new URL(value);if(u.hostname!=='127.0.0.1'||u.pathname!=='/b22_disposable_review')throw Error('Refusing non-disposable database');
 clients[name]=new pg.Client({connectionString:value});
}
await Promise.all(Object.values(clients).map(c=>c.connect()));
try{
 let registry,operatorRegistry;
 if(process.argv[2]==='execute'){
  registry=await createEphemeralTestWalletRegistry({client:clients.signer,provider});
  const buyer=registry.createBuyer();operatorRegistry=await createLocalOperatorRegistry({client:clients.executor,provider});
  process.send?.({phase:'ready',buyer:buyer.address,operator:operatorRegistry.address});
 }else if(process.argv[2]!=='recover')throw Error('Invalid worker phase');
 else process.send?.({phase:'awaiting'});
 const args=await new Promise(resolve=>process.once('message',resolve));
 const session=await restoreLocalChainSession(clients.preflight,{sessionId:args.sessionId,provider});
 if(process.argv[2]==='execute'){
  const original=clients.executor.query.bind(clients.executor),broadcast=provider.broadcastTransaction.bind(provider);let handedOff=false;
  clients.executor.query=async(...params)=>{const out=await original(...params);if(typeof params[0]==='string'&&params[0].includes('b25_authorize_handoff')){handedOff=true;if(args.crashPoint==='handoff'){process.send?.({phase:'handoff'});await new Promise(()=>{});}}return out;};
  provider.broadcastTransaction=async(...params)=>{const tx=await broadcast(...params);if(handedOff&&args.crashPoint==='broadcast'){await tx.wait();process.send?.({phase:'broadcast'});await new Promise(()=>{});}return tx;};
 }
 const run=await ensureMarketRun(clients.coord,{start:new Date(args.slot)});
 const result=await processMarketRun({coordinationClient:clients.coord,matchingClient:clients.matcher,run,workerId:randomUUID(),localPayments:{clients,provider,registry,operatorRegistry,minter:process.argv[2]==='execute'?await provider.getSigner(0):undefined,allocations:new Map([[args.allocationId,{policyId:args.policyId,deploymentId:args.deploymentId,session,grantId:args.grantId}]]),sessions:new Map([[args.reservationId,session]])}});
 await new Promise((resolve,reject)=>process.send({phase:'result',state:result.state,paid:result.report?.verifiedPaidBaseUnits,unresolved:result.report?.unresolved},error=>error?reject(error):resolve()));
 completed=true;process.disconnect();
}finally{await Promise.allSettled(Object.values(clients).map(c=>c.end()));provider.destroy();}
