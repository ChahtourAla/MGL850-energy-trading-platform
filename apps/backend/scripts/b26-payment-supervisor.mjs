/**
 * Disposable-only payment supervisor. The owner holds the B24 test registry;
 * callers provide run and allocation identities, never keys or payment terms.
 * This is not a production custody service.
 */
import {renewMarketRun} from './b26-market-run.mjs';
import {discoverExistingAuthorization} from './b26-authorization-discovery.mjs';
import {processLocalAllocation} from './b26-local-payment.mjs';
import {reconcileLocalMarket} from './b25-settlement-reconciliation.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=/^0x[0-9a-f]{64}$/i;

/**
 * A trusted fixture owner constructs this with separately authenticated B24,
 * B25 and B26 connections. It retains ownership of all wallet capabilities.
 * Reservations, sessions and grants must already have been approved.
 */
export function createOfflinePaymentSupervisor({coordinationClient,matchingClient,localPayments,fixtureProvisioner}) {
 if(!localPayments?.clients||!localPayments.sessions||!localPayments.grantsBySession)throw Error('Approved local payment context required');
 const matcher=matchingClient?.connectionParameters;
 if(matcher?.host!=='127.0.0.1'||matcher?.database!=='b22_disposable_review'||matcher?.user!=='b22_match')throw Error('Refusing non-disposable supervisor matcher');
 let queue=Promise.resolve();
 async function execute(request,assertActive){
  if(!request||!uuid.test(request.runId)||!uuid.test(request.workerId)||!hash.test(request.allocationId)||!/^\d+$/.test(String(request.fence)))throw Error('Invalid supervised payment request');
  const {runId,workerId,allocationId}=request,fence=String(request.fence);
  const checkLease=async()=>{assertActive?.();const run=await renewMarketRun(coordinationClient,{runId,workerId,fence});assertActive?.();return run;};
  const run=await checkLease();
  if(run.status!=='MATCHED'||!run.planId||!run.snapshotId)throw Error('Run is not ready for supervised payment');
  const allocation=await matchingClient.query('SELECT id FROM "V2Allocation" WHERE id=$1 AND "planId"=$2 AND "snapshotId"::text=$3 AND status=\'VALIDATED\'',[allocationId,run.planId,run.snapshotId]);
  if(allocation.rowCount!==1)throw Error('Allocation does not belong to the claimed run');
  const slot=new Date(run.intervalStart).toISOString().replace('.000Z','Z');
  let approved=await discoverExistingAuthorization({client:localPayments.clients.evaluator,executor:localPayments.clients.executor,preflight:localPayments.clients.preflight,provider:localPayments.provider,slot,allocationId,sessions:localPayments.sessions,grantsBySession:localPayments.grantsBySession});
  if(['POLICY_CANDIDATE','NEEDS_PROVISIONING'].includes(approved.state)){
   if(!fixtureProvisioner)return {state:'BLOCKED',reason:'APPROVED_LOCAL_CAPABILITY_MISSING',simulationOnly:true};
   approved=await fixtureProvisioner.provision({slot,allocationId,policyId:approved.policyId,deploymentId:approved.deploymentId,checkLease});
  }
  if(approved.state==='BLOCKED')return {state:'BLOCKED',reason:approved.reason,simulationOnly:true};
  const result=await processLocalAllocation({slot,allocationId,policyId:approved.policyId,deploymentId:approved.deploymentId,session:approved.session,grantId:approved.grantId,clients:localPayments.clients,provider:localPayments.provider,registry:localPayments.registry,operatorRegistry:localPayments.operatorRegistry,minter:localPayments.minter,b26Fence:{runId,workerId,fence},checkLease});
  // Never return signatures, wallet objects, database credentials or raw terms.
  return {state:result.state,reason:result.reason??null,attemptId:result.attemptId??null,simulationOnly:true};
 }
 async function reconcile(request){
  if(!request||!uuid.test(request.runId)||!uuid.test(request.workerId)||!/^\d+$/.test(String(request.fence)))throw Error('Invalid supervised reconciliation request');
  const {runId,workerId}=request,fence=String(request.fence);
  const run=await renewMarketRun(coordinationClient,{runId,workerId,fence});
  if(run.status!=='MATCHED'||!run.planId)throw Error('Run is not ready for supervised reconciliation');
  const q=await matchingClient.query('SELECT "marketId" FROM "V2AllocationPlan" WHERE id=$1 AND status=\'AUTHORITATIVE\'',[run.planId]);
  if(q.rowCount!==1)throw Error('Authoritative plan unavailable');
  const report=await reconcileLocalMarket({client:localPayments.clients.reporter,verifierClient:localPayments.clients.verifier,provider:localPayments.provider,marketId:q.rows[0].marketId,sessions:localPayments.sessions});
  const final=(await localPayments.clients.verifier.query('SELECT b26_record_reconciliation($1,$2,$3,$4) AS run',[runId,workerId,fence,JSON.stringify(report)])).rows[0].run;
  return {state:final.status,run:final,report,simulationOnly:true};
 }
 const serialized=operation=>{const result=queue.then(operation);queue=result.catch(()=>{});return result;};
 return Object.freeze({execute:(request,{assertActive}={})=>serialized(()=>execute(request,assertActive)),reconcile:request=>serialized(()=>reconcile(request))});
}
