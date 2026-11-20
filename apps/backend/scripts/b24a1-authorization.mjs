/** Disposable-only B24-A1 reservation prototype. Never signs or submits transactions. */
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {inspectHistoricalHour} from './b22a-ingestion.mjs';
import {reconcile} from './b22b-matching.mjs';
import {verifyCandidatePlan} from './b24a-plan.mjs';
import {assessSpendingPolicy} from './b24a-policy.mjs';
import {buildSettlement} from '../../../packages/contracts/src/b23-identity.ts';
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
async function guard(c){
 const t=c.connectionParameters;if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b24_evaluator')throw Error('Refusing non-disposable B24 target');
 const r=await c.query("SELECT current_database() AS db,session_user AS role,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS ok");
 if(r.rows[0]?.db!=='b22_disposable_review'||r.rows[0]?.role!=='b24_evaluator'||!r.rows[0]?.ok)throw Error('B24 disposable marker or authenticated role missing');
}
async function historical(c,slot,allocationId){
 const history=await inspectHistoricalHour(c,slot);if(history.state!=='FINALIZED')throw Error('Historical source not finalized');
 const market=await c.query('SELECT * FROM "V2Market" WHERE id=$1',[history.marketId]);if(market.rowCount!==1||market.rows[0].intervalEnd.getTime()>Date.now())throw Error('Market is not complete');
 const plans=await c.query('SELECT * FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[history.marketId]);if(plans.rowCount!==1)throw Error('Authoritative plan missing or ambiguous');
 const record=plans.rows[0],checked=await reconcile(c,slot,history,record);
 const verified=verifyCandidatePlan({marketId:checked.marketId,snapshotId:checked.snapshotId,planId:checked.planId,snapshotHash:checked.manifest.snapshotHash,manifest:checked.manifest,manifestHash:checked.manifestHash,planVersion:record.planVersion,allocations:checked.allocations});
 const allocation=checked.allocations.find(a=>a.id===allocationId);if(!allocation)throw Error('Allocation absent from authoritative plan');
 return {checked,allocation,commitment:verified.commitment};
}
async function readApprovals(c,policyId,deploymentId,lock){
 const p=await c.query('SELECT * FROM "B24SpendingPolicy" WHERE id=$1'+(lock?' FOR UPDATE':''),[policyId]);
 const d=await c.query('SELECT * FROM "B24Deployment" WHERE id=$1'+(lock?' FOR UPDATE':''),[deploymentId]);
 if(p.rowCount!==1||d.rowCount!==1)throw Error('Policy or deployment not approved');
 const artifact=JSON.parse(readFileSync(new URL('../../../packages/contracts/artifacts/contracts/EnergyTradingDirectSettlement.sol/EnergyTradingDirectSettlement.json',import.meta.url),'utf8'));
 if(d.rows[0].chainId!==31337||d.rows[0].tokenDecimals!==6||d.rows[0].codeHash!==keccak256(artifact.deployedBytecode)||d.rows[0].artifactHash!==keccak256(artifact.bytecode)||!d.rows[0].approvalPrincipal||!d.rows[0].approvalEvidence)throw Error('Deployment not approved as test fixture');
 return {policy:p.rows[0],deployment:d.rows[0]};
}
/** Historical inspection is read-only and does not assess current signing eligibility. */
export async function inspectReservation(c,allocationId){
 await guard(c);
 const result=await c.query('SELECT * FROM "B24AuthorizationReservation" WHERE "allocationId"=$1',[allocationId]);
 return result.rowCount ? {historicalStatus:result.rows[0].status,currentEligibility:'NOT_EVALUATED',reservation:result.rows[0]} : null;
}
/** Preview is read-only; execute requires explicit opt-in and the authenticated test role. */
export async function prepareAuthorization(c,{slot,allocationId,policyId,deploymentId,execute=false}){
 await guard(c);if(execute)await c.query('BEGIN');
 try{
  const h=await historical(c,slot,allocationId),{allocation:a,checked}=h;
  if(execute)await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['B24_BUYER_NONCE',`${deploymentId}:${a.buyerAddress}`]);
  const {policy:p,deployment:d}=await readApprovals(c,policyId,deploymentId,execute);
  const existing=await c.query('SELECT * FROM "B24AuthorizationReservation" WHERE "allocationId"=$1',[a.id]);
  if(existing.rowCount){const e=existing.rows[0];if(e.policyId!==p.id||e.deploymentId!==d.id||e.planCommitment!==h.commitment||e.amountBaseUnits!==a.amountBaseUnits||e.status!=='RESERVED')throw Error('Conflicting existing reservation');const rebuilt=buildSettlement({status:'AUTHORITATIVE',allocationStatus:a.status,marketId:a.marketId,snapshotHash:checked.manifest.snapshotHash,manifestHash:checked.manifestHash,allocationIds:checked.allocations.map(x=>x.id),allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,algorithmVersion:a.algorithmVersion,pricingPolicyVersion:a.pricingVersion,token:d.tokenAddress,chainId:BigInt(d.chainId),contractAddress:d.contractAddress,nonce:BigInt(e.nonce),deadline:BigInt(Math.floor(e.deadline.getTime()/1000))});if(e.settlementId!==rebuilt.settlementId||!isDeepStrictEqual(e.terms,JSON.parse(json(rebuilt))))throw Error('Stored unsigned authorization mismatch');// The stored record remains reserved even when permission lapses. Reassess the
  // policy against all other reservations, so this reservation is counted once.
  const total=await c.query('SELECT coalesce(sum("amountBaseUnits"),0)::text AS total FROM "B24AuthorizationReservation" WHERE "policyId"=$1',[p.id]);
  const others=BigInt(total.rows[0].total)-BigInt(e.amountBaseUnits);
  if(others<0n)throw Error('Reservation budget inconsistent');
  let assessment=d.status!=='TEST_FIXTURE' ? {state:'BLOCKED',reason:'DEPLOYMENT_NOT_APPROVED'} : assessSpendingPolicy({policy:{...p,effectiveAt:p.effectiveAt.toISOString(),expiresAt:p.expiresAt.toISOString()},allocation:a,deployment:d,reservedBaseUnits:others.toString(),now:new Date(Date.now()).toISOString()});
  if(assessment.state==='CANDIDATE_POLICY_PASS' && Date.now()>=e.deadline.getTime())assessment={state:'EXPIRED',reason:'AUTHORIZATION_DEADLINE_EXPIRED'};
  if(execute)await c.query('COMMIT');
  if(assessment.state!=='CANDIDATE_POLICY_PASS')return {state:assessment.state,reason:assessment.reason,historicalStatus:e.status,currentEligibility:'BLOCKED',reservationId:e.id};
  return {state:'RESERVED',reused:true,currentEligibility:'CURRENT_OFFLINE_FIXTURE',reservation:e};}
  if(d.status!=='TEST_FIXTURE')throw Error('Deployment not approved as test fixture');
  const sum=await c.query('SELECT coalesce(sum("amountBaseUnits"),0)::text AS total FROM "B24AuthorizationReservation" WHERE "policyId"=$1',[p.id]);
  const assessment=assessSpendingPolicy({policy:{...p,effectiveAt:p.effectiveAt.toISOString(),expiresAt:p.expiresAt.toISOString()},allocation:a,deployment:d,reservedBaseUnits:sum.rows[0].total,now:new Date(Date.now()).toISOString()});
  if(assessment.state!=='CANDIDATE_POLICY_PASS')throw Error(`Policy blocked: ${assessment.reason}`);
  const n=await c.query('SELECT coalesce(max(nonce),-1)+1 AS next FROM "B24AuthorizationReservation" WHERE "deploymentId"=$1 AND "buyerAddress"=$2',[d.id,a.buyerAddress]);
  const nonce=BigInt(n.rows[0].next),deadlineMs=Math.min(Date.now()+9*60*1000,p.expiresAt.getTime());
  const deadline=BigInt(Math.floor(deadlineMs/1000));if(deadline<=BigInt(Math.floor(Date.now()/1000)))throw Error('Policy deadline expired');
  const built=buildSettlement({status:'AUTHORITATIVE',allocationStatus:a.status,marketId:a.marketId,snapshotHash:checked.manifest.snapshotHash,manifestHash:checked.manifestHash,allocationIds:checked.allocations.map(x=>x.id),allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,algorithmVersion:a.algorithmVersion,pricingPolicyVersion:a.pricingVersion,token:d.tokenAddress,chainId:BigInt(d.chainId),contractAddress:d.contractAddress,nonce,deadline});
  if(built.terms.planCommitment!==h.commitment||built.terms.amountBaseUnits.toString()!==a.amountBaseUnits)throw Error('Unsigned settlement mismatch');
  if(!execute)return {state:'POLICY_APPROVED',persisted:false,terms:JSON.parse(json(built))};
  const r=await c.query('INSERT INTO "B24AuthorizationReservation"(id,"allocationId","marketId","deploymentId","policyId","buyerAddress","amountBaseUnits",nonce,deadline,"planCommitment","settlementId",terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[randomUUID(),a.id,a.marketId,d.id,p.id,a.buyerAddress,a.amountBaseUnits,nonce.toString(),new Date(Number(deadline)*1000),h.commitment,built.settlementId,json(built)]);
  await c.query('COMMIT');const stored=await c.query('SELECT * FROM "B24AuthorizationReservation" WHERE id=$1',[r.rows[0].id]);if(stored.rowCount!==1||stored.rows[0].settlementId!==built.settlementId||!isDeepStrictEqual(stored.rows[0].terms,JSON.parse(json(built))))throw Error('Committed reservation readback mismatch');return {state:'RESERVED',reused:false,reservation:stored.rows[0]};
 }catch(error){if(execute)await c.query('ROLLBACK');throw error;}
}
