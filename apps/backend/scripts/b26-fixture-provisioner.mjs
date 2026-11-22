/** Separately authorized disposable fixture setup; not a production custody path. */
import {randomUUID} from 'node:crypto';
import {getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {prepareAuthorization} from './b24a1-authorization.mjs';
import {hasRegisteredTestBuyer} from './b24-signing.mjs';
import {establishLocalChainSession,restoreLocalChainSession} from './b24-local-chain-session.mjs';

/**
 * The test owner supplies approvals keyed by archived buyer address. Each
 * approval names an already-approved deployment, funding budget and anchor.
 * This component never creates a spending policy or an aggregate budget.
 */
export async function createDisposableFixtureProvisioner({approvalClient,evaluator,preflight,provider,registry,minter,buyerApprovals,sessions,grantsBySession}){
 const p=approvalClient?.connectionParameters;
 if(p?.host!=='127.0.0.1'||p?.database!=='b22_disposable_review'||p?.user!=='b24_approver'||!(buyerApprovals instanceof Map))throw Error('Disposable fixture approver required');
 const guard=await approvalClient.query("SELECT session_user actor,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') guarded");
 if(guard.rows[0]?.actor!=='b24_approver'||guard.rows[0]?.guarded!==true||(await provider.getNetwork()).chainId!==31337n)throw Error('Unapproved fixture environment');
 const minterAddress=getAddress(await minter.getAddress()).toLowerCase();
 return Object.freeze({async provision({slot,allocationId,policyId,deploymentId,checkLease}){
  const a=await evaluator.query('SELECT "buyerAddress","amountBaseUnits" FROM "V2Allocation" WHERE id=$1 AND status=\'VALIDATED\'',[allocationId]);
  if(a.rowCount!==1)throw Error('Validated allocation required');
  const buyer=getAddress(a.rows[0].buyerAddress).toLowerCase(),approval=buyerApprovals.get(buyer);
  if(!approval||approval.deploymentId!==deploymentId||!hasRegisteredTestBuyer(registry,buyer))return {state:'BLOCKED',reason:'APPROVED_LOCAL_CAPABILITY_MISSING'};
  const budget=await approvalClient.query('SELECT * FROM "B24LocalFundingBudget" WHERE id=$1',[approval.budgetId]);
  const deployment=await evaluator.query('SELECT "tokenAddress" FROM "B24Deployment" WHERE id=$1 AND status=\'TEST_FIXTURE\' AND "chainId"=31337',[deploymentId]);
  if(budget.rowCount!==1||deployment.rowCount!==1||budget.rows[0].status!=='ACTIVE'||budget.rows[0].buyerAddress!==buyer||budget.rows[0].tokenAddress!==deployment.rows[0].tokenAddress||budget.rows[0].minterAddress!==minterAddress)throw Error('Preapproved funding budget mismatch');
  await checkLease();
  const reserved=await prepareAuthorization(evaluator,{slot,allocationId,policyId,deploymentId,execute:true});
  if(reserved.state!=='RESERVED')return {state:'BLOCKED',reason:reserved.reason??reserved.state};
  const reservationId=reserved.reservation.id;
  await approvalClient.query('BEGIN');
  try{
   await approvalClient.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['B26_FIXTURE_SESSION',reservationId]);
   const stored=await approvalClient.query('SELECT id FROM "B24LocalChainSession" WHERE "reservationId"=$1 AND status=\'ACTIVE\'',[reservationId]);
   if(stored.rowCount>1)throw Error('Ambiguous local session');
   let session=sessions.get(reservationId);
   if(stored.rowCount){if(!session||session.id!==stored.rows[0].id)session=await restoreLocalChainSession(preflight,{sessionId:stored.rows[0].id,provider});}
   else {await checkLease();session=await establishLocalChainSession(preflight,{reservationId,provider,anchorTransactionHash:approval.anchorTransactionHash,approvalClient});}
   const grants=await approvalClient.query('SELECT g.id FROM "B24LocalFundingGrant" g JOIN "B24LocalFundingBudgetGrant" bg ON bg."grantId"=g.id WHERE g."sessionId"=$1 AND g.status=\'ACTIVE\' AND g."minterAddress"=$2 AND bg."budgetId"=$3',[session.id,minterAddress,approval.budgetId]);
   if(grants.rowCount>1)throw Error('Ambiguous local funding grant');
   let grantId=grants.rows[0]?.id;
   if(!grantId){
    await checkLease();grantId=randomUUID();const amount=String(a.rows[0].amountBaseUnits);
    await approvalClient.query('INSERT INTO "B24LocalFundingGrant"(id,"sessionId","minterAddress","perOperationLimit","cumulativeLimit","approvedBy") VALUES($1,$2,$3,$4,$4,\'fixture\')',[grantId,session.id,minterAddress,amount]);
    await approvalClient.query('INSERT INTO "B24LocalFundingBudgetGrant"("grantId","budgetId") VALUES($1,$2)',[grantId,approval.budgetId]);
   }
   await approvalClient.query('COMMIT');sessions.set(reservationId,session);grantsBySession.set(session.id,grantId);
   return {state:'APPROVED',policyId,deploymentId,session,grantId};
  }catch(error){await approvalClient.query('ROLLBACK');throw error;}
 }});
}
