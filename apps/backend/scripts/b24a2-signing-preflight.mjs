/** Read-only, disposable-test-only verification. Never an authorization to sign. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {keccak256,TypedDataEncoder} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {inspectHistoricalHour} from './b22a-ingestion.mjs';
import {reconcile} from './b22b-matching.mjs';
import {verifyCandidatePlan} from './b24a-plan.mjs';
import {assessSpendingPolicy} from './b24a-policy.mjs';
import {buildSettlement,planCommitment,settlementTypes} from '../../../packages/contracts/src/b23-identity.ts';
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const fail=(reason)=>{const e=Error(reason);e.preflightReason=reason;throw e;};
const one=async(c,sql,args,reason)=>{const q=await c.query(sql,args);if(q.rowCount!==1)fail(reason);return q.rows[0];};
/** A point-in-time simulation result, never a durable signing grant. */
export async function verifySigningPreflight(c,{reservationId}){
 const target=c.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_preflight')throw Error('Refusing non-disposable preflight target');
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const guard=await one(c,"SELECT current_database() db,session_user role,transaction_timestamp() now,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') ok",[],'GUARD');
  if(guard.db!=='b22_disposable_review'||guard.role!=='b24_preflight'||!guard.ok)fail('GUARD');
  const r=await one(c,'SELECT * FROM "B24AuthorizationReservation" WHERE id=$1',[reservationId],'RESERVATION_NOT_FOUND');
  const market=await one(c,'SELECT * FROM "V2Market" WHERE id=$1',[r.marketId],'MARKET_NOT_FOUND');
  if(market.intervalEnd>guard.now)fail('MARKET_INCOMPLETE');
  const slot=market.intervalStart.toISOString().replace('.000Z','Z');
  const history=await inspectHistoricalHour(c,slot);
  if(history.state!=='FINALIZED'||history.marketId!==r.marketId)fail('HISTORICAL_SOURCE_INVALID');
  const plan=await one(c,'SELECT * FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[r.marketId],'AUTHORITATIVE_PLAN_INVALID');
  const checked=await reconcile(c,slot,history,plan);
  const check=verifyCandidatePlan({marketId:checked.marketId,snapshotId:checked.snapshotId,planId:checked.planId,snapshotHash:checked.manifest.snapshotHash,manifest:checked.manifest,manifestHash:checked.manifestHash,planVersion:plan.planVersion,allocations:checked.allocations});
  const a=checked.allocations.find(x=>x.id===r.allocationId);if(!a)fail('ALLOCATION_NOT_IN_PLAN');
  const commitment=planCommitment(checked.marketId,checked.manifest.snapshotHash,checked.manifestHash,checked.allocations.map(x=>x.id));
  if(commitment!==check.commitment||commitment!==r.planCommitment)fail('PLAN_COMMITMENT_MISMATCH');
  const p=await one(c,'SELECT * FROM "B24SpendingPolicy" WHERE id=$1',[r.policyId],'POLICY_NOT_FOUND');
  const d=await one(c,'SELECT * FROM "B24Deployment" WHERE id=$1',[r.deploymentId],'DEPLOYMENT_NOT_FOUND');
  if(d.status!=='TEST_FIXTURE')fail('DEPLOYMENT_BLOCKED');
  const artifact=JSON.parse(readFileSync(new URL('../../../packages/contracts/artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url),'utf8'));
  if(d.chainId!==31337||d.tokenDecimals!==6||d.codeHash!==keccak256(artifact.deployedBytecode)||d.artifactHash!==keccak256(artifact.bytecode)||!d.approvalPrincipal||!d.approvalEvidence||!d.verifiedAt)fail('DEPLOYMENT_INTEGRITY');
  if(r.status!=='RESERVED'||r.buyerAddress!==a.buyerAddress||r.amountBaseUnits!==a.amountBaseUnits||r.marketId!==a.marketId||p.deploymentId!==d.id||p.version<1)fail('RESERVATION_CONTEXT_MISMATCH');
  const unique=await one(c,'SELECT count(*)::int n FROM "B24AuthorizationReservation" WHERE "allocationId"=$1',[r.allocationId],'ALLOCATION_UNIQUENESS');if(unique.n!==1)fail('ALLOCATION_UNIQUENESS');
  const nonce=await one(c,'SELECT count(*)::int n FROM "B24AuthorizationReservation" WHERE "deploymentId"=$1 AND "buyerAddress"=$2 AND nonce=$3',[d.id,a.buyerAddress,r.nonce],'NONCE_UNIQUENESS');if(nonce.n!==1||BigInt(r.nonce)<0n)fail('NONCE_UNIQUENESS');
  if(r.deadline.getMilliseconds()!==0||r.deadline>p.expiresAt)fail('DEADLINE_INVALID');
  const deadline=BigInt(Math.floor(r.deadline.getTime()/1000));
  const built=buildSettlement({status:'AUTHORITATIVE',allocationStatus:a.status,marketId:a.marketId,snapshotHash:checked.manifest.snapshotHash,manifestHash:checked.manifestHash,allocationIds:checked.allocations.map(x=>x.id),allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,algorithmVersion:a.algorithmVersion,pricingPolicyVersion:a.pricingVersion,token:d.tokenAddress,chainId:BigInt(d.chainId),contractAddress:d.contractAddress,nonce:BigInt(r.nonce),deadline});
  const encoded=JSON.parse(stringify(built));
  if(TypedDataEncoder.hash(built.domain,settlementTypes,built.terms)!==r.settlementId||built.settlementId!==r.settlementId||!isDeepStrictEqual(encoded,r.terms))fail('TYPED_DATA_MISMATCH');
  const total=await one(c,'SELECT coalesce(sum("amountBaseUnits"),0)::text total FROM "B24AuthorizationReservation" WHERE "policyId"=$1',[p.id],'BUDGET_INVALID');
  const others=BigInt(total.total)-BigInt(r.amountBaseUnits);if(others<0n)fail('BUDGET_INVALID');
  const assessment=assessSpendingPolicy({policy:{...p,effectiveAt:p.effectiveAt.toISOString(),expiresAt:p.expiresAt.toISOString()},allocation:a,deployment:d,reservedBaseUnits:others.toString(),now:guard.now.toISOString()});
  if(assessment.state!=='CANDIDATE_POLICY_PASS')fail(assessment.reason);
  // Minimum 60 seconds remaining according to the DB transaction clock.
  if(r.deadline.getTime()-guard.now.getTime()<60000)fail('DEADLINE_INSUFFICIENT');
  const finalTime=await one(c,'SELECT clock_timestamp() AS now',[],'CLOCK_UNAVAILABLE');
  if(r.deadline.getTime()-finalTime.now.getTime()<60000 || p.expiresAt.getTime()<=finalTime.now.getTime())fail('DEADLINE_INSUFFICIENT');
  await c.query('COMMIT');
  return {state:'SIMULATION_ELIGIBLE',reservationId:r.id,allocationId:a.id,historicalPlanVerified:true,policyCurrentlyValid:true,deploymentFixtureVerified:true,typedDataVerified:true,nonceVerified:true,deadlineVerified:true,simulationOnly:true,realSigningAuthorized:false};
 }catch(error){await c.query('ROLLBACK');return {state:'BLOCKED',reason:error.preflightReason??'INTEGRITY_FAILURE',simulationOnly:true,realSigningAuthorized:false};}
}
