import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
import {verifyCandidatePlan} from './b24a-plan.mjs';
const f=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/b22-hourly-prototype.json',import.meta.url)));
const config=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/matching-config.sample.json',import.meta.url)));
test('verified B22 candidate commitment is stable and tampering fails',async()=>{
 const proposal=await runHourlyDryRun(f.snapshot,f.registry,config,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:7,now:Date.parse('2026-10-17T15:00:00Z'),python:process.env.B21_PYTHON||'python'});
 const users=new Map(proposal.manifest.participants.map(p=>[p.userId,p]));
 const snapshotId=f.snapshot.snapshotId,planId='0x'+'1'.repeat(64);
 const allocations=proposal.allocations.filter(x=>!x.policyBlocked).map(a=>({id:a.allocationId,marketId:proposal.marketId,snapshotId,planId,planVersion:proposal.planVersion,algorithmVersion:proposal.manifest.algorithmVersion,pricingVersion:proposal.manifest.pricingPolicyVersion,buyerId:a.buyerId,sellerId:a.sellerId,buyerAddress:users.get(a.buyerId).evmAddress,sellerAddress:users.get(a.sellerId).evmAddress,quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.unitPriceMicrousdPerKwh,amountBaseUnits:a.amountBaseUnits,remainder:a.remainder,status:'VALIDATED'}));
 assert.ok(allocations.length>0);
 const input={marketId:proposal.marketId,snapshotId,planId,snapshotHash:proposal.snapshotHash,manifest:proposal.manifest,manifestHash:proposal.manifestHash,planVersion:proposal.planVersion,allocations};
 const result=verifyCandidatePlan(input);assert.equal(result.allocationCount,allocations.length);assert.match(result.commitment,/^0x[0-9a-f]{64}$/);
 assert.throws(()=>verifyCandidatePlan({...input,manifestHash:'0x'+'0'.repeat(64)}),/Manifest commitment/);
 assert.throws(()=>verifyCandidatePlan({...input,allocations:[{...allocations[0],id:'0x'+'0'.repeat(64)}]}),/Allocation identity/);
 assert.throws(()=>verifyCandidatePlan({...input,allocations:[allocations[0],allocations[0]]}),/duplicate/);
});
