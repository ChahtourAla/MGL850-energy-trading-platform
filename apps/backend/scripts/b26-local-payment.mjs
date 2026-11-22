/** Local B24/B25 coordination. All authority and financial facts remain in accepted services. */
import {prepareAuthorization} from './b24a1-authorization.mjs';
import {createOfflineSigningService} from './b24-signing.mjs';
import {fundLocalReservation} from './b24-funding.mjs';
import {setLocalAllowance} from './b24-allowance.mjs';
import {inspectLocalReadiness} from './b24-readiness.mjs';
import {createLocalSettlementIntent,localFixtureIntentId} from './b25-settlement-intent.mjs';
import {executeLocalSettlement} from './b25-settlement-executor.mjs';
import {recoverLocalSettlement} from './b25-settlement-recovery.mjs';

/** Fixture approval and session enrollment are performed separately by authorized setup. */
export async function processLocalAllocation({slot,allocationId,policyId,deploymentId,session,registry,operatorRegistry,provider,minter,grantId,clients,b26Fence,checkLease}) {
 // The B25 database independently fences attempt creation and dispatch. These
 // additional checks prevent a worker that already knows it lost its lease
 // from starting further B24 preparation. A call already handed to a service
 // may still complete and must be reconciled by its durable journal.
 const assertCurrent=async()=>{if(checkLease)await checkLease();};
 await assertCurrent();
 const existing=await clients.evaluator.query('SELECT r.id,r."policyId",r."deploymentId",d."tokenAddress" FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r."allocationId"=$1',[allocationId]);
 if(existing.rowCount>1)throw Error('Conflicting allocation reservation');
 if(existing.rowCount){
  const row=existing.rows[0];
  if(row.policyId!==policyId||row.deploymentId!==deploymentId)throw Error('Conflicting B24 authorization context');
  const intentId=localFixtureIntentId(allocationId,row.tokenAddress);
  let context;
  try { context=(await clients.executor.query('SELECT "b25_local_context"($1) context',[intentId])).rows[0]?.context; }
  catch(error){ if(!String(error.message).includes('B25 intent missing'))throw error; }
  if(context?.attempt){
   if(!session||context.sessionId!==session.id)throw Error('B25 session mismatch');
   return recoverLocalSettlement({client:clients.verifier,provider,session,attemptId:context.attempt.id});
  }
 }
 const prepared=await prepareAuthorization(clients.evaluator,{slot,allocationId,policyId,deploymentId,execute:true});
 if(prepared.state!=='RESERVED')return {state:'BLOCKED',reason:prepared.reason??prepared.state};
 const reservationId=prepared.reservation.id;
 if(!session)return {state:'BLOCKED',reason:'LOCAL_SESSION_REQUIRED',reservationId};
 const signing=createOfflineSigningService({client:clients.signer,preflightClient:clients.preflight,registry,session});
 await assertCurrent();
 await signing.signReservation(reservationId);
 await assertCurrent();
 // Treat a rejected funding RPC or database call as UNKNOWN, never as permission
 // to rerun an already prepared operation. B24's durable journal owns recovery.
 let funding;
 try { funding=await fundLocalReservation({client:clients.funder,preflightClient:clients.preflight,receiptClient:clients.receiptVerifier,provider,session,minter,reservationId,grantId}); }
 catch { return {state:'UNRESOLVED',reason:'FUNDING_OUTCOME_UNKNOWN',reservationId}; }
 if(!['VERIFIED','FUNDING_NOT_REQUIRED'].includes(funding.state))return {state:'UNRESOLVED',reason:'FUNDING_OUTCOME_UNKNOWN',reservationId};
 await assertCurrent();
 // An uncertain allowance must also fail closed; the canonical B24 operation
 // identifier, if allocated, remains durable and is reused on recovery.
 let allowance;
 try { allowance=await setLocalAllowance({client:clients.allowance,preflightClient:clients.preflight,receiptClient:clients.receiptVerifier,provider,session,registry,reservationId}); }
 catch { return {state:'UNRESOLVED',reason:'ALLOWANCE_OUTCOME_UNKNOWN',reservationId}; }
 if(allowance.state!=='VERIFIED')return {state:'UNRESOLVED',reason:'ALLOWANCE_OUTCOME_UNKNOWN',reservationId};
 const readiness=await inspectLocalReadiness(clients.preflight,{reservationId,provider,session});
 if(readiness.state!=='READY_FOR_LOCAL_SETTLEMENT')return {state:readiness.state==='UNRESOLVED'?'UNRESOLVED':'BLOCKED',reason:readiness.reason??readiness.state,reservationId};
 await assertCurrent();
 const intent=await createLocalSettlementIntent({client:clients.executor,preflightClient:clients.preflight,reservationId,provider,session});
 await assertCurrent();
 const attempt=await executeLocalSettlement({client:clients.executor,preflightClient:clients.preflight,provider,session,registry:operatorRegistry,intentId:intent.intentId,b26Fence});
 if(!attempt.attemptId)return {state:'UNRESOLVED',reason:'ATTEMPT_NOT_AVAILABLE',reservationId};
 return recoverLocalSettlement({client:clients.verifier,provider,session,attemptId:attempt.attemptId});
}
