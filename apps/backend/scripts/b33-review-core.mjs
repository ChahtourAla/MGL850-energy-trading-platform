/** Pure, deterministic human-approval and multi-hour safety checks; no IO. */
import {createHash} from 'node:crypto';
const hex64=/^0x[0-9a-f]{64}$/;
const canon=(x)=>JSON.stringify(x);
const sha=x=>'0x'+createHash('sha256').update(canon(x),'utf8').digest('hex');
export const PAID_HOUR='2026-11-10T14:00:00Z';
export const OTHER_HOURS=Object.freeze(['04','09','10','11','12','13','15']);
export function assertSevenHours(hours,day='2026-11-10') {
 if(!Array.isArray(hours)||hours.length!==7)throw Error('Expected seven additional V2 markets');
 const expected=new Set(OTHER_HOURS.map(h=>`${day}T${h}:00:00Z`));
 for(const h of hours){if(!expected.delete(h.slot))throw Error('Missing/duplicate/unexpected hour or paid 14:00 hour');}
 if(expected.size)throw Error('Required historical trading hour missing');
}
export function approvedMarketView(plan,sourceSHA,slot){
 if(!hex64.test(plan.marketId)||!hex64.test(plan.snapshotHash)||!hex64.test(plan.planId)||!hex64.test(plan.manifestHash)||!hex64.test(plan.proposalDigest)||!/^([A-F0-9]{64})$/i.test(sourceSHA)||!Array.isArray(plan.allocations)||!plan.allocations.length)throw Error('Incomplete reviewed plan');
 const allocations=plan.allocations.map(a=>({id:a.id,buyerId:a.buyerId,sellerId:a.sellerId,buyerAddress:a.buyerAddress.toLowerCase(),sellerAddress:a.sellerAddress.toLowerCase(),quantityWh:String(a.quantityWh),price:String(a.unitPriceMicrousdPerKwh),amountBaseUnits:String(a.amountBaseUnits),remainder:Number(a.remainder)})).sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(allocations.map(a=>a.id)).size!==allocations.length||allocations.some(a=>!hex64.test(a.id)||!/^0x[0-9a-f]{40}$/.test(a.buyerAddress)||!/^0x[0-9a-f]{40}$/.test(a.sellerAddress)||a.buyerAddress===a.sellerAddress||!/^[1-9]\d*$/.test(a.amountBaseUnits)))throw Error('Unsafe market allocation');
 return {slot,sourceSha256:sourceSHA.toLowerCase(),marketId:plan.marketId,snapshotId:plan.snapshotId,snapshotHash:plan.snapshotHash,planId:plan.planId,manifestHash:plan.manifestHash,planVersion:plan.planVersion,proposalDigest:plan.proposalDigest,pricingPolicyVersion:'b28-teusd-half-even-1',allocations,allocationCount:allocations.length,amountBaseUnits:allocations.reduce((a,x)=>a+BigInt(x.amountBaseUnits),0n).toString()};
}
export function buildReview(day,hours){
 assertSevenHours(hours,day);
 const canonical=[...hours].sort((a,b)=>a.slot.localeCompare(b.slot));
 const result={format:'MGL850_B33_APPROVAL_V1',day,existing14HourMustRemainUntouched:true,hours:canonical};
 return {...result,reviewDigest:sha(['mgl850:b33:day-review:1',result])};
}
export function assertApprovedFile(file,expected) {
 if(!file||file.format!=='MGL850_B33_APPROVAL_V1'||file.day!==expected.day||file.existing14HourMustRemainUntouched!==true||!hex64.test(file.reviewDigest))throw Error('Invalid B33 human review manifest');
 assertSevenHours(file.hours,file.day);
 if(canon(file)!==canon(expected))throw Error('Approved markets differ from newly computed source and payment terms');
 if(file.reviewDigest!==sha(['mgl850:b33:day-review:1',{format:file.format,day:file.day,existing14HourMustRemainUntouched:true,hours:file.hours}]))throw Error('Invalid review digest');
 return true;
}
export function classifyAllocation(intent,attempts,evidence,onChainPaid){
 if(evidence?.length>1)throw Error('Duplicate settlement evidence');
 if(!intent){if(attempts?.length||evidence?.length||onChainPaid!==false)throw Error('Unknown/previous on-chain or journal state');return 'ELIGIBLE';}
 if(intent.status==='CONFIRMED'&&evidence?.length===1&&evidence[0].verificationStatus==='VERIFIED'&&evidence[0].receiptStatus==='SUCCESS'&&onChainPaid===true)return 'CONFIRMED';
 if(intent.status==='READY'&&attempts?.length===1&&attempts[0].transactionIdentity==='B28_APPROVAL'&&attempts[0].status==='CONFIRMED'&&onChainPaid===false)return 'RESUME_AFTER_APPROVAL';
 throw Error('Unconfirmed or conflicting settlement state; reconcile before payment');
}
export function checkTransferCounts(rows){
 if(!rows.length)throw Error('No allocations to audit');
 const keys=new Set();
 for(const r of rows){if(!hex64.test(r.id)||keys.has(r.id))throw Error('Duplicate/bad allocation');keys.add(r.id);}
 return rows.length;
}
