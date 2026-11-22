/** Discover existing reservations; this service cannot grant policy or session approval. */
import {prepareAuthorization} from './b24a1-authorization.mjs';
import {localFixtureIntentId} from './b25-settlement-intent.mjs';
import {restoreLocalChainSession} from './b24-local-chain-session.mjs';

export async function discoverExistingAuthorization({client,executor,preflight,provider,slot,allocationId,sessions,grantsBySession}) {
 const target=client?.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_evaluator')throw Error('Refusing non-disposable authorization discovery');
 const q=await client.query('SELECT r."policyId",r."deploymentId",r.id,d."tokenAddress" FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r."allocationId"=$1',[allocationId]);
 if(q.rowCount===0){
  // An allocation must already belong to a validated authoritative plan. The
  // B24 preview independently verifies the complete historical plan and limits.
  const candidates=await client.query(`SELECT p.id AS "policyId",p."deploymentId" FROM "V2Allocation" a JOIN "V2AllocationPlan" plan ON plan.id=a."planId" JOIN "B24SpendingPolicy" p ON p."buyerId"=a."buyerId" AND p."buyerAddress"=a."buyerAddress" JOIN "B24Deployment" d ON d.id=p."deploymentId" AND d."tokenAddress"=p."tokenAddress" WHERE a.id=$1 AND a.status='VALIDATED' AND plan.status='AUTHORITATIVE' AND (p."marketId" IS NULL OR p."marketId"=a."marketId") AND p.status='ACTIVE' AND p."consentKind"='SIMULATED_TEST' AND d.status='TEST_FIXTURE' AND d."chainId"=31337`,[allocationId]);
  const eligible=[];
  for(const candidate of candidates.rows){
   try {const result=await prepareAuthorization(client,{slot,allocationId,...candidate,execute:false});if(result.state==='POLICY_APPROVED')eligible.push(candidate);}
   catch(error){if(!String(error.message).startsWith('Policy blocked:'))throw error;}
  }
  if(eligible.length>1)return {state:'BLOCKED',reason:'AMBIGUOUS_AUTHORIZATION'};
  if(!eligible.length)return {state:'BLOCKED',reason:'NO_APPLICABLE_POLICY'};
  // B24's session approval is reservation-bound. A policy alone cannot grant
  // the additional signer, funding and operator capabilities required to pay.
  return {state:'POLICY_CANDIDATE',...eligible[0]};
 }
 if(q.rowCount!==1)throw Error('Conflicting existing authorization');
 const row=q.rows[0];
 // Revocation blocks new dispatch, but cannot retract a committed handoff.
 // Permit read-only B25 recovery of an existing attempt without granting a new
 // signature or funding capability. B25 authenticates the verifier and session.
 let session=sessions.get(row.id);
 if(executor){
  let context;
  try {context=(await executor.query('SELECT "b25_local_context"($1) AS context',[localFixtureIntentId(allocationId,row.tokenAddress)])).rows[0]?.context;}
  catch(error){if(!String(error.message).includes('B25 intent missing'))throw error;}
  if(context?.attempt){
   // A restarted process can reconstruct only the public chain-session
   // capability for the original attempt. This requires the authenticated B24
   // preflight role and rechecks the recorded anchor and runtime bytecode; it
   // does not recreate a buyer signer or authorize a replacement transaction.
   if(!session&&preflight&&provider){
    session=await restoreLocalChainSession(preflight,{sessionId:context.sessionId,provider});
    sessions.set(row.id,session);
   }
   if(!session)return {state:'BLOCKED',reason:'RECOVERY_SESSION_UNAVAILABLE'};
   if(context.sessionId!==session.id)throw Error('B25 session mismatch');
   return {state:'RECOVERY_ONLY',policyId:row.policyId,deploymentId:row.deploymentId,session};
  }
 }
 const verified=await prepareAuthorization(client,{slot,allocationId,policyId:row.policyId,deploymentId:row.deploymentId,execute:false});
 if(verified.state!=='RESERVED')return {state:'BLOCKED',reason:verified.reason??verified.state};
 const grantId=session&&grantsBySession.get(session.id);
 if(!session||!grantId)return {state:'NEEDS_PROVISIONING',policyId:row.policyId,deploymentId:row.deploymentId};
 return {state:'APPROVED',policyId:row.policyId,deploymentId:row.deploymentId,session,grantId};
}
