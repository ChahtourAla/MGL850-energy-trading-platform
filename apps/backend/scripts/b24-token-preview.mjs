/** Arithmetic preview only: input facts are untrusted and no authorization is implied. */
import {uint} from '../../../packages/shared/v2-identity.mjs';
export function previewTokenRequirements({amountBaseUnits,balanceBaseUnits,allowanceBaseUnits,allowanceCapBaseUnits}) {
 const amount=uint(amountBaseUnits),balance=uint(balanceBaseUnits),allowance=uint(allowanceBaseUnits),cap=uint(allowanceCapBaseUnits);
 if(amount===0n)throw Error('positive payment required');
 if(amount>cap) return {state:'ALLOWANCE_CAP_EXCEEDED',simulationOnly:true,authorizationVerified:false};
 return {state:'UNVERIFIED',simulationOnly:true,authorizationVerified:false,amountBaseUnits:amount.toString(),fundingShortfallBaseUnits:(balance>=amount?0n:amount-balance).toString(),allowanceShortfallBaseUnits:(allowance>=amount?0n:amount-allowance).toString(),currentAllowanceExceedsCap:allowance>cap};
}
