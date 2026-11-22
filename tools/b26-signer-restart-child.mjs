/**
 * Offline-only disposable signer restart integration fixture.
 * The trusted test harness passes a short-lived seed over private Node IPC;
 * this child never writes it to disk or forwards it to the scheduler.
 */
import pg from '../apps/backend/node_modules/pg/lib/index.js';
import {JsonRpcProvider,getAddress} from '../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {createOfflineSigningService,createSeededDisposableTestWalletRegistry} from '../apps/backend/scripts/b24-signing.mjs';
import {restoreLocalChainSession} from '../apps/backend/scripts/b24-local-chain-session.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function localUrl(value,role){
 const url=new URL(value??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/b22_disposable_review'||decodeURIComponent(url.username)!==role)throw Error('Refusing non-disposable signer restart');
 return value;
}
async function main({seed,reservationId,sessionId,expectedBuyer}){
 if(process.env.B26_TEST_SIGNER_RESTART!=='1'||!process.connected)throw Error('Private test custody IPC required');
 if(!uuid.test(reservationId??'')||!uuid.test(sessionId??'')||typeof expectedBuyer!=='string')throw Error('Invalid signer restart identity');
 const rpc=new URL(process.env.B25_LOCAL_RPC_URL??'');
 if(rpc.protocol!=='http:'||rpc.hostname!=='127.0.0.1'||!rpc.port)throw Error('Refusing non-disposable signer RPC');
 const signer=new pg.Client({connectionString:localUrl(process.env.B24_SIGNER_DATABASE_URL,'b24_signer')});
 const preflight=new pg.Client({connectionString:localUrl(process.env.B24_PREFLIGHT_DATABASE_URL,'b24_preflight')});
 const provider=new JsonRpcProvider(rpc.toString(),31337);
 try{
  await Promise.all([signer.connect(),preflight.connect()]);
  if((await provider.getNetwork()).chainId!==31337n)throw Error('Wrong disposable chain');
  const {registry,buyers}=await createSeededDisposableTestWalletRegistry({client:signer,provider,seed,count:2});
  if(getAddress(buyers[1].address)!==getAddress(expectedBuyer))throw Error('Custody identity mismatch');
  const session=await restoreLocalChainSession(preflight,{sessionId,provider});
  const signed=await createOfflineSigningService({client:signer,preflightClient:preflight,registry,session}).signReservation(reservationId);
  if(signed.state!=='SIGNED_OFFLINE'||signed.reused)throw Error('Expected new unsigned allocation');
  return {phase:'signed',reservationId,reused:signed.reused};
 }finally{await Promise.allSettled([signer.end(),preflight.end()]);provider.destroy();}
}
if(!process.connected||process.env.B26_TEST_SIGNER_RESTART!=='1')throw Error('Disposable restart mode required');
process.once('message',async request=>{
 try{
  const result=await main(request);
  process.send?.(result,()=>process.disconnect?.());
 }catch{
  // In particular, never echo the private IPC seed or database credentials.
  process.send?.({phase:'failed'},()=>process.disconnect?.());
  process.exitCode=1;
 }
});
