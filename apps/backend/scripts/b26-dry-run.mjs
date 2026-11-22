/** Read-only preview: matching uses archived B22 evidence and never persists a plan. */
import {inspectHistoricalHour} from './b22a-ingestion.mjs';
import {processFinalizedHour} from './b22b-matching.mjs';
import {requireHour} from './b11-pipeline-core.mjs';
export async function previewMarketRun(client,slot){
 requireHour(slot);
 if(Date.parse(slot)+3600000>Date.now())throw Error('B26 hour is not closed');
 const history=await inspectHistoricalHour(client,slot);
 if(history.state==='ABSENT')return {state:'WAITING_FOR_DATA',simulationOnly:true,financialWrites:false};
 if(history.state!=='FINALIZED')return {state:'BLOCKED',reason:'UNTRUSTED_SNAPSHOT',simulationOnly:true,financialWrites:false};
 const plan=await processFinalizedHour(client,slot,{execute:false,configuration:'v1-default'});
 const allocations=plan.allocations.map(a=>({allocationId:a.allocationId??a.id,buyerId:a.buyerId,sellerId:a.sellerId,quantityWh:String(a.quantityWh),unitPriceMicrousdPerKwh:String(a.unitPriceMicrousdPerKwh),amountBaseUnits:String(a.amountBaseUnits),remainder:Number(a.remainder),authorization:'NOT_CHECKED'}));
 const expectedBaseUnits=allocations.reduce((sum,a)=>sum+BigInt(a.amountBaseUnits),0n).toString();
 return {state:allocations.length===0?'NO_MATCH':plan.policyBlocked?'BLOCKED':'MATCHED',marketId:history.marketId,snapshotId:history.snapshots[0].snapshotId,planId:plan.planId,allocationCount:allocations.length,allocations,expectedBaseUnits,authorization:'NOT_CHECKED',simulationOnly:true,financialWrites:false};
}
