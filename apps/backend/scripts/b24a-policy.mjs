/** B24-A policy arithmetic only. A successful result is not proof of authenticated consent. */
import {uint} from '../../../packages/shared/v2-identity.mjs';

/** Pure check over facts independently loaded from trusted storage by a future service. */
export function assessSpendingPolicy({policy,allocation,deployment,reservedBaseUnits,now}) {
 if(!policy) return {state:'NO_POLICY',reason:'NO_POLICY'};
 if(!deployment || !['TEST_FIXTURE','VERIFIED_ACTIVE'].includes(deployment.status)) return {state:'BLOCKED',reason:'DEPLOYMENT_NOT_APPROVED'};
 if(policy.consentKind!=='SIMULATED_TEST' || deployment.status!=='TEST_FIXTURE') return {state:'BLOCKED',reason:'CONSENT_NOT_VERIFIED_FOR_OFFLINE_MODE'};
 if(policy.status==='REVOKED') return {state:'REVOKED',reason:'POLICY_REVOKED'};
 if(policy.status!=='ACTIVE') return {state:'BLOCKED',reason:'POLICY_NOT_ACTIVE'};
 const timestamp=Date.parse(now),start=Date.parse(policy.effectiveAt),expiry=Date.parse(policy.expiresAt);
 if(![timestamp,start,expiry].every(Number.isFinite)||expiry<=start) throw Error('Invalid policy time');
 if(timestamp<start) return {state:'BLOCKED',reason:'POLICY_NOT_EFFECTIVE'};
 if(timestamp>=expiry) return {state:'EXPIRED',reason:'POLICY_EXPIRED'};
 if(!policy.approver || !policy.auditReference) return {state:'BLOCKED',reason:'MISSING_APPROVAL_EVIDENCE'};
 if(policy.buyerId!==allocation.buyerId || policy.buyerAddress!==allocation.buyerAddress || policy.deploymentId!==deployment.id || policy.tokenAddress!==deployment.tokenAddress || (policy.marketId!==null && policy.marketId!==allocation.marketId)) return {state:'BLOCKED',reason:'POLICY_SCOPE_MISMATCH'};
 const amount=uint(allocation.amountBaseUnits), maximum=uint(policy.perAllocationLimit), budget=uint(policy.cumulativeLimit), reserved=uint(reservedBaseUnits);
 if(amount===0n) return {state:'INELIGIBLE',reason:'ZERO_PAYMENT'};
 if(amount>maximum) return {state:'BLOCKED',reason:'PER_ALLOCATION_LIMIT'};
 if(reserved>budget || amount>budget-reserved) return {state:'BLOCKED',reason:'CUMULATIVE_LIMIT'};
 return {state:'CANDIDATE_POLICY_PASS',amountBaseUnits:amount.toString(),remainingAfterReservation:(budget-reserved-amount).toString()};
}
