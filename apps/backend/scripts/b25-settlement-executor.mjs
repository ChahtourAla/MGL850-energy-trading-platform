/** Disposable-only execution. Once an attempt is recorded, retries never broadcast again. */
import {randomUUID} from 'node:crypto';
import {Wallet,Contract,Interface,getAddress,keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {inspectLocalReadiness} from './b24-readiness.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {withClientLock} from './b24-client-lock.mjs';
import {withLocalTimeout} from './b24-local-timeout.mjs';

const registryState=new WeakMap();
const abi=new Interface(['function settle((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s,bytes signature)','function OPERATOR_ROLE() view returns(bytes32)','function hasRole(bytes32,address) view returns(bool)','function paused() view returns(bool)','function executedSettlements(bytes32) view returns(bool)','function paidAllocations(bytes32) view returns(bool)','function usedNonces(address,uint256) view returns(bool)','function marketPlans(bytes32) view returns(bytes32)','function marketSnapshots(bytes32) view returns(bytes32)']);
function guard(client){const t=client?.connectionParameters;if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b25_executor')throw Error('Refusing non-disposable B25 executor');}
/** The local operator is generated internally; only its public address is exposed. */
export async function createLocalOperatorRegistry({client,provider}){
 guard(client);
 const q=await client.query("SELECT session_user AS actor,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS guarded");
 if(q.rows[0]?.actor!=='b25_executor'||!q.rows[0]?.guarded||(await provider.getNetwork()).chainId!==31337n)throw Error('Unapproved B25 local operator registry');
 const wallet=Wallet.createRandom().connect(provider),registry=Object.freeze({address:wallet.address});
 registryState.set(registry,{wallet,provider,host:client.connectionParameters.host,database:client.connectionParameters.database,port:client.connectionParameters.port});
 return registry;
}
export async function executeLocalSettlement({client,preflightClient,provider,session,registry,intentId}){
 guard(client);
 const state=registryState.get(registry),t=client.connectionParameters;
 if(!state||state.provider!==provider||state.host!==t.host||state.database!==t.database||state.port!==t.port)throw Error('Unregistered B25 operator');
 return withClientLock(client,async()=>{
  const x=(await client.query('SELECT "b25_local_context"($1) context',[intentId])).rows[0]?.context;
  if(!x||x.sessionId!==session?.id)throw Error('B25 intent context invalid');
  if(x.attempt)return {state:'UNRESOLVED',phase:x.attempt.handedOff?'HANDED_OFF':'PREPARED',attemptId:x.attempt.id,transactionHash:x.attempt.transactionHash,reused:true,simulationOnly:true};
  const preflight=await verifySigningPreflight(preflightClient,{reservationId:x.reservationId});
  if(preflight.state!=='SIMULATION_ELIGIBLE')throw Error('B25 preflight blocked');
  const ready=await withLocalTimeout(inspectLocalReadiness(preflightClient,{reservationId:x.reservationId,provider,session}));
  if(ready.state!=='READY_FOR_LOCAL_SETTLEMENT')throw Error(`B25 readiness blocked: ${ready.state}`);
  if(!verifyRecordedAuthorization(x,x.signature))throw Error('B25 signature invalid');
  await withLocalTimeout(assertLocalChainSession(session,{provider,reservationId:x.reservationId,buyer:x.buyerAddress,token:x.tokenAddress,contract:x.contractAddress}));
  const contract=new Contract(x.contractAddress,abi,provider),s=x.terms.terms;
  const [role,paused,executed,paid,used,plan,snapshot]=await withLocalTimeout(Promise.all([contract.OPERATOR_ROLE(),contract.paused(),contract.executedSettlements(x.settlementId),contract.paidAllocations(x.allocationId),contract.usedNonces(x.buyerAddress,s.nonce),contract.marketPlans(s.marketId),contract.marketSnapshots(s.marketId)]));
  const zero='0x'+'00'.repeat(32);
  if(paused||executed||paid||used||!await withLocalTimeout(contract.hasRole(role,state.wallet.address))||BigInt(s.deadline)<=BigInt(Math.floor(Date.now()/1000))||(plan!==zero&&(plan.toLowerCase()!==s.planCommitment.toLowerCase()||snapshot.toLowerCase()!==s.snapshotHash.toLowerCase())))throw Error('B25 on-chain preflight blocked');
  const data=abi.encodeFunctionData('settle',[s,x.signature]);
  const nonce=await withLocalTimeout(provider.getTransactionCount(state.wallet.address,'pending'));
  const fee=await withLocalTimeout(provider.getFeeData());
  if(!Number.isSafeInteger(nonce)||nonce<0||fee.gasPrice===null)throw Error('B25 operator transaction parameters unavailable');
  const raw=await withLocalTimeout(state.wallet.signTransaction({chainId:31337,to:getAddress(x.contractAddress),data,nonce,gasLimit:1000000n,gasPrice:fee.gasPrice,type:0,value:0}));
  const hash=keccak256(raw).toLowerCase(),attemptId=randomUUID();
  const q=await client.query('SELECT "b25_prepare_local_attempt"($1,$2,$3,$4,$5,$6,$7) attempt',[intentId,attemptId,session.id,state.wallet.address.toLowerCase(),nonce,hash,keccak256(data).toLowerCase()]);
  const attempt=q.rows[0]?.attempt;if(!attempt)throw Error('B25 attempt reservation failed');
  if(attempt.reused)return {state:'UNRESOLVED',attemptId:attempt.id,transactionHash:attempt.transactionHash,reused:true,simulationOnly:true};
  // Commit the authorization before handing the signed transaction to the
  // provider. This durable handoff is the linearization point: revocation
  // blocks future handoffs, but cannot retract this already in-flight attempt.
  try{await withLocalTimeout(assertLocalChainSession(session,{provider,reservationId:x.reservationId,buyer:x.buyerAddress,token:x.tokenAddress,contract:x.contractAddress}));}
  catch{return {state:'BLOCKED_BEFORE_HANDOFF',attemptId,transactionHash:hash,reused:false,simulationOnly:true};}
  try{await client.query('SELECT "b25_authorize_handoff"($1)',[attemptId]);}
  catch(error){
   // A lost database response may follow a committed handoff. Never label
   // that outcome cancelled or attempt another dispatch.
   if(error?.code==='P0001'&&error.message.includes('B25 authorization expired or changed'))return {state:'BLOCKED_BEFORE_HANDOFF',attemptId,transactionHash:hash,reused:false,simulationOnly:true};
   return {state:'UNRESOLVED',phase:'HANDOFF_UNKNOWN',attemptId,transactionHash:hash,reused:false,simulationOnly:true};
  }
  // A timeout is never cancellation. The committed handoff remains unresolved;
  // this process and all retries must never broadcast this attempt again.
  try{await withLocalTimeout(provider.broadcastTransaction(raw));}
  catch{return {state:'UNRESOLVED',attemptId,transactionHash:hash,reused:false,simulationOnly:true};}
  return {state:'SUBMITTED',attemptId,transactionHash:hash,reused:false,simulationOnly:true};
 });
}
