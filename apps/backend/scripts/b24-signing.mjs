/** Offline-only signing. Do not connect this prototype to a real wallet or network. */
import {randomUUID,createHmac} from 'node:crypto';
import {Contract,TypedDataEncoder,verifyTypedData,getAddress,Wallet} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {withLocalTimeout} from './b24-local-timeout.mjs';

const registries=new WeakMap();
const clientQueues=new WeakMap();
async function serializeClient(client,operation){
 const previous=clientQueues.get(client)??Promise.resolve();
 let release;const current=new Promise(resolve=>{release=resolve;});
 clientQueues.set(client,current);
 await previous;
 try{return await operation();}finally{release();if(clientQueues.get(client)===current)clientQueues.delete(client);}
}
function checkTarget(client){
 if(client?.connectionParameters?.host!=='127.0.0.1'||client?.connectionParameters?.database!=='b22_disposable_review'||client?.connectionParameters?.user!=='b24_signer')throw Error('Refusing non-disposable signer target');
}

/** Test-harness-only registry. It generates its own keys and exposes only addresses.
 * The authenticated harness and signer process remain trusted; this is not production custody.
 */
export async function createEphemeralTestWalletRegistry({client,provider}){
 checkTarget(client);
 const q=await client.query("SELECT current_database() db,session_user actor,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') guarded");
 if(q.rowCount!==1||q.rows[0].db!=='b22_disposable_review'||q.rows[0].actor!=='b24_signer'||!q.rows[0].guarded||(await provider.getNetwork()).chainId!==31337n)throw Error('Unapproved test wallet registry');
 const wallets=new Map();
 const registry=Object.freeze({createBuyer(){const wallet=Wallet.createRandom();const address=getAddress(wallet.address);wallets.set(address,wallet);return Object.freeze({address});}});
 registries.set(registry,{wallets,provider,host:client.connectionParameters.host,database:client.connectionParameters.database,port:client.connectionParameters.port});
 return registry;
}

/**
 * Deterministic, disposable fixture recovery ONLY. A trusted test harness
 * keeps a randomly generated seed outside the restarted signer process and
 * provides it over its private child IPC channel. No production key store,
 * wallet export, file storage, or network-facing recovery interface exists.
 *
 * Callers never receive a private key; the registry remains in the WeakMap.
 */
export async function createSeededDisposableTestWalletRegistry({client,provider,seed,count}){
 if(process.env.B26_TEST_SIGNER_RESTART!=='1')throw Error('Test signer restart is disabled');
 if(typeof seed!=='string'||!/^0x[0-9a-f]{64}$/i.test(seed)||!Number.isSafeInteger(count)||count<1||count>8)throw Error('Invalid disposable test signer recovery');
 const registry=await createEphemeralTestWalletRegistry({client,provider});
 const record=registries.get(registry),buyers=[];
 for(let index=0;index<count;index++){
  // HMAC domain separation prevents accidental cross-use of the fixture seed.
  const material=createHmac('sha256',Buffer.from(seed.slice(2),'hex')).update(`mgl850-b26-fixture-v1:${index}`).digest('hex');
  const wallet=new Wallet('0x'+material),address=getAddress(wallet.address);
  if(record.wallets.has(address))throw Error('Duplicate disposable test buyer');
  record.wallets.set(address,wallet);
  buyers.push(Object.freeze({address}));
 }
 return Object.freeze({registry,buyers:Object.freeze(buyers)});
}

/** Public membership check only; the registry never exports key material. */
export function hasRegisteredTestBuyer(registry,address){
 const registered=registries.get(registry);
 if(!registered)return false;
 try{return registered.wallets.has(getAddress(address));}catch{return false;}
}

export function createOfflineSigningService({client,preflightClient,registry,session}) {
 checkTarget(client);
 const registered=registries.get(registry);
 if(!registered||registered.host!==client.connectionParameters.host||registered.database!==client.connectionParameters.database||registered.port!==client.connectionParameters.port)throw Error('Registered local test wallet registry required');
 return Object.freeze({async signReservation(reservationId){return serializeClient(client,async()=>{
  const verified=await verifySigningPreflight(preflightClient,{reservationId});
  if(verified.state!=='SIMULATION_ELIGIBLE')throw Error(`Signing preflight blocked: ${verified.reason}`);
  await client.query('BEGIN');
  try{
   // Database function locks policy and deployment until COMMIT, serializing revocation.
   const {rows}=await client.query('SELECT "b24_sign_lock"($1) AS reservation',[reservationId]);const r=rows[0]?.reservation;
   if(!r||r.id!==reservationId)throw Error('Reservation missing');
   await assertLocalChainSession(session,{provider:registered.provider,reservationId,buyer:r.buyerAddress,token:r.terms.terms.token,contract:r.terms.domain.verifyingContract});
   const address=getAddress(r.buyerAddress),wallet=registered.wallets.get(address);
   if(!wallet)throw Error('Archived buyer has no registered test signer');
   const t=r.terms,digest=TypedDataEncoder.hash(t.domain,t.types,t.terms);
   if(digest!==r.settlementId||t.settlementId!==digest||getAddress(t.terms.buyer)!==address)throw Error('Signing digest mismatch');
   const prior=(await client.query('SELECT "b24_sign_lookup"($1) AS signature',[reservationId])).rows[0].signature;
   const signature=prior??await wallet.signTypedData(t.domain,t.types,t.terms);
   if(getAddress(verifyTypedData(t.domain,t.types,t.terms,signature))!==address)throw Error('Signer recovery mismatch');
   const result=await client.query('SELECT "b24_sign_record"($1,$2,$3,$4) AS signature',[reservationId,randomUUID(),signature.toLowerCase(),digest]);
   if(result.rows[0].signature!==signature.toLowerCase())throw Error('Persisted signature mismatch');
   await client.query('COMMIT');
   // A second current-state check can withhold a committed signature after revocation.
   // It cannot revoke a signature after release; caller must treat this as test-only.
   await client.query('BEGIN');
   await client.query('SELECT "b24_sign_lock"($1)',[reservationId]);
   await assertLocalChainSession(session,{provider:registered.provider,reservationId,buyer:r.buyerAddress,token:r.terms.terms.token,contract:r.terms.domain.verifyingContract});
   const released=(await client.query('SELECT "b24_sign_lookup"($1) AS signature',[reservationId])).rows[0].signature;
   if(released!==result.rows[0].signature)throw Error('Recorded signature changed');
   if(!verifyRecordedAuthorization(r,released))throw Error('Recorded signature verification failed');
   await client.query('COMMIT');
   return {state:'SIGNED_OFFLINE',reservationId,settlementId:digest,signature:released,reused:prior!==null,simulationOnly:true};
  }catch(error){await client.query('ROLLBACK');throw error;}
 });}});
}
/** Live custody is intentionally unavailable. */
export function createProductionSigner(){throw Error('Production signer is disabled');}

/** Uses a registry-owned key only for a database-locked local approval operation. */
export async function submitRegisteredLocalAllowance({client,preflightClient,registry,session,operationId,provider}){
 const target=client?.connectionParameters,registered=registries.get(registry);
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_allowance'||!registered||registered.host!==target.host||registered.database!==target.database||registered.port!==target.port||registered.provider!==provider)throw Error('Unapproved local allowance signer');
 await client.query('BEGIN');
 try{
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
  const op=(await client.query('SELECT "b24_lock_local_allowance"($1) AS context',[operationId])).rows[0]?.context;
  if(!op||op.session_id!==session?.id)throw Error('Allowance operation context invalid');
  if(BigInt(op.targetAmount)>0n){const preflight=await verifySigningPreflight(preflightClient,{reservationId:op.reservation_id});if(preflight.state!=='SIMULATION_ELIGIBLE')throw Error('Allowance preflight blocked');}
  await withLocalTimeout(assertLocalChainSession(session,{provider,reservationId:op.reservation_id,buyer:op.buyerAddress,token:op.tokenAddress,contract:op.contractAddress}));
  const wallet=registered.wallets.get(getAddress(op.buyerAddress));if(!wallet)throw Error('Archived buyer has no registered test signer');
  const nonce=Number(op.senderNonce);if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('Allowance nonce outside safe range');
  const token=new Contract(op.tokenAddress,['function approve(address,uint256)'],wallet.connect(provider));
  const tx=await withLocalTimeout(token.approve(op.contractAddress,BigInt(op.targetAmount),{nonce}));
  await client.query('SELECT "b24_submit_local_allowance"($1,$2)',[operationId,tx.hash.toLowerCase()]);
  await client.query('COMMIT');
  return tx;
 }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
}
