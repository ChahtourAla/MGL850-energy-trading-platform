import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewTokenRequirements} from './b24-token-preview.mjs';
const input={amountBaseUnits:'2541',balanceBaseUnits:'1000',allowanceBaseUnits:'40',allowanceCapBaseUnits:'2541'};
test('exact preview does not grant authorization',()=>assert.deepEqual(previewTokenRequirements(input),{state:'UNVERIFIED',simulationOnly:true,authorizationVerified:false,amountBaseUnits:'2541',fundingShortfallBaseUnits:'1541',allowanceShortfallBaseUnits:'2501',currentAllowanceExceedsCap:false}));
test('balance and allowance at or above payment have no shortfall',()=>{const r=previewTokenRequirements({...input,balanceBaseUnits:'3000',allowanceBaseUnits:'3000'});assert.equal(r.fundingShortfallBaseUnits,'0');assert.equal(r.allowanceShortfallBaseUnits,'0');assert.equal(r.currentAllowanceExceedsCap,true);});
test('reject cap below payment',()=>assert.equal(previewTokenRequirements({...input,allowanceCapBaseUnits:'2540'}).state,'ALLOWANCE_CAP_EXCEEDED'));
test('reject malformed, negative, zero and out-of-range amounts',()=>{for(const v of ['0','-1','1.0','01','9223372036854775808',3])assert.throws(()=>previewTokenRequirements({...input,amountBaseUnits:v}));});
