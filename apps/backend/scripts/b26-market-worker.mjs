/** B22-integrated local worker. Existing financial services retain their own database identities. */
import {inspectHistoricalHour} from './b22a-ingestion.mjs';
import {processFinalizedHour} from './b22b-matching.mjs';
import {claimMarketRun,checkpointMarketRun,releaseMarketRun,renewMarketRun} from './b26-market-run.mjs';
import {processLocalAllocation} from './b26-local-payment.mjs';
import {reconcileLocalMarket} from './b25-settlement-reconciliation.mjs';
import {discoverExistingAuthorization} from './b26-authorization-discovery.mjs';

export async function processMarketRun({coordinationClient,matchingClient,run,workerId,localPayments}) {
 const claim=await claimMarketRun(coordinationClient,{runId:run.id,workerId});
 if(!claim)return {state:run.status==='NO_MATCH'?'ALREADY_COMPLETE':'DEFERRED',runId:run.id};
 let leaseError=null, renewal=Promise.resolve(), stopped=false;
 const timer=setInterval(()=>{if(stopped||leaseError)return; renewal=renewal.then(async()=>{if(!stopped)await renewMarketRun(coordinationClient,{runId:run.id,workerId,fence:claim.fence});}).catch(error=>{leaseError=error;});},15000);
 timer.unref();
 const checkLease=async()=>{await renewal;if(leaseError)throw Error('B26 lease renewal failed');await renewMarketRun(coordinationClient,{runId:run.id,workerId,fence:claim.fence});};
 const finish=async(state,code,retrySeconds=0)=>releaseMarketRun(coordinationClient,{runId:run.id,workerId,fence:claim.fence,state,code,retrySeconds});
 let paymentProcessingStarted=false;
 try {
 const slot=new Date(claim.intervalStart).toISOString().replace('.000Z','Z');
 const history=await inspectHistoricalHour(matchingClient,slot);
 if(history.state==='ABSENT'){await finish('WAITING_FOR_DATA','SOURCE_MISSING',60);return {state:'WAITING_FOR_DATA',runId:run.id};}
 if(history.state!=='FINALIZED'){await finish('BLOCKED','UNTRUSTED_SNAPSHOT',-1);return {state:'BLOCKED',reason:'UNTRUSTED_SNAPSHOT',runId:run.id};}
 const snapshot=history.snapshots[0];
 await checkLease();
 if(claim.status==='WAITING_FOR_DATA'||claim.status==='SNAPSHOT_FINALIZED'||(claim.status==='BLOCKED'&&!claim.planId)) await checkpointMarketRun(coordinationClient,{runId:run.id,workerId,fence:claim.fence,state:'SNAPSHOT_FINALIZED',snapshotId:snapshot.snapshotId,snapshotHash:snapshot.payloadHash});
 else if(!['MATCHED','BLOCKED','NEEDS_RECONCILIATION','SETTLED','PARTIALLY_SETTLED'].includes(claim.status)||claim.snapshotId!==snapshot.snapshotId||claim.snapshotHash!==snapshot.payloadHash) throw Error('B26 conflicting checkpoint');
 const result=await processFinalizedHour(matchingClient,slot,{execute:true,configuration:claim.configuration});
 await checkLease();
 if(result.status!=='AUTHORITATIVE'){await finish('BLOCKED','PLAN_NOT_AUTHORITATIVE',-1);return {state:'BLOCKED',reason:'PLAN_NOT_AUTHORITATIVE',runId:run.id};}
 const nextState=result.allocations.length===0?'NO_MATCH':'MATCHED';
 await checkpointMarketRun(coordinationClient,{runId:run.id,workerId,fence:claim.fence,state:nextState,snapshotId:snapshot.snapshotId,snapshotHash:snapshot.payloadHash,planId:result.planId});
 if(nextState==='NO_MATCH'){const final=await finish('NO_MATCH','NONE');return {state:'NO_MATCH',run:final,allocations:0};}
 if(!localPayments){const final=await finish('MATCHED','NONE');return {state:'MATCHED',run:final,allocations:result.allocations.length};}
 paymentProcessingStarted=true;
 const outcomes=[];
 for(const allocation of result.allocations){
  await checkLease();
  const allocationId=allocation.id??allocation.allocationId;
  if(localPayments.supervisor){
   try{outcomes.push({allocationId,...await localPayments.supervisor.execute({runId:run.id,workerId,fence:String(claim.fence),allocationId})});}
   catch{outcomes.push({allocationId,state:'UNRESOLVED',reason:'SUPERVISOR_OUTCOME_UNKNOWN'});}
   continue;
  }
  const approved=localPayments.grantsBySession
   ? await discoverExistingAuthorization({client:localPayments.clients.evaluator,executor:localPayments.clients.executor,preflight:localPayments.clients.preflight,provider:localPayments.provider,slot,allocationId,sessions:localPayments.sessions,grantsBySession:localPayments.grantsBySession})
   : localPayments.allocations?.get(allocationId);
  if(!approved||!['APPROVED','RECOVERY_ONLY',undefined].includes(approved.state)){outcomes.push({allocationId,state:'BLOCKED',reason:approved?.reason??'APPROVED_LOCAL_CAPABILITY_MISSING'});continue;}
  try{outcomes.push({allocationId,...await processLocalAllocation({slot,allocationId,policyId:approved.policyId,deploymentId:approved.deploymentId,session:approved.session,grantId:approved.grantId,clients:localPayments.clients,provider:localPayments.provider,registry:localPayments.registry,operatorRegistry:localPayments.operatorRegistry,minter:localPayments.minter,b26Fence:{runId:run.id,workerId,fence:claim.fence},checkLease})});}
  catch{outcomes.push({allocationId,state:'UNRESOLVED',reason:'PAYMENT_OUTCOME_UNKNOWN'});}
 }
 await checkLease();
 if(localPayments.remoteSupervisor){
  const final=await localPayments.supervisor.reconcile({runId:run.id,workerId,fence:String(claim.fence)});
  return {state:final.state,run:final.run,allocations:result.allocations.length,outcomes,report:final.report};
 }
 const report=await reconcileLocalMarket({client:localPayments.clients.reporter,verifierClient:localPayments.clients.verifier,provider:localPayments.provider,marketId:history.marketId,sessions:localPayments.sessions});
 await checkLease();
 // Do not persist SETTLED: B25 reconciliation must be rechecked before each financial report.
 const final=(await localPayments.clients.verifier.query('SELECT b26_record_reconciliation($1,$2,$3,$4) AS run',[run.id,workerId,String(claim.fence),JSON.stringify(report)])).rows[0].run;
 return {state:final.status,run:final,allocations:result.allocations.length,outcomes,report};
 } catch(error) {
  try{await finish(paymentProcessingStarted||claim.status==='NEEDS_RECONCILIATION'?'NEEDS_RECONCILIATION':'BLOCKED',paymentProcessingStarted||claim.status==='NEEDS_RECONCILIATION'?'PAYMENT_OUTCOME_UNKNOWN':'PROCESSING_ERROR',Number(claim.attempts)>=5?-1:Math.min(300,2**Number(claim.attempts)));}catch{}
  throw error;
 } finally {stopped=true;clearInterval(timer);await renewal;}
}
