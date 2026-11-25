/** B35: pure, deterministic zero-seller matching replay evidence. */
import {createHash} from 'node:crypto';
function stableJson(value) {
 if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
 return JSON.stringify(value)??'null';
}

export const B35_DAY='2026-11-10';
export const B35_MISSING_HOURS=Object.freeze(['07','08','16','17','18','19','20','21']);
export const B35_CONFIRM='APPROVE_B35_8_ZERO_MATCH_RUNS';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function b35Slots(day=B35_DAY){
 if(day!==B35_DAY)throw Error('B35 is restricted to the reviewed November 10, 2026 demonstration');
 return B35_MISSING_HOURS.map(h=>`${day}T${h}:00:00Z`);
}
export function validateZeroReplay(input,output,plan){
 if(!input||!output||!plan||!Array.isArray(input.users)||input.users.length!==12)throw Error('Incomplete replay input');
 const b=input.users.filter(x=>x.marketRole==='BUYER'),s=input.users.filter(x=>x.marketRole==='SELLER');
 if(b.length===0||s.length!==0||b.length>12)throw Error('Hour is not an eligible zero-seller scenario');
 if(output.timeSlot!==input.timeSlot||output.snapshotId!==input.snapshotId||output.algorithmVersion!==input.algorithmVersion)throw Error('Matching output identity differs from input');
 if(output.matches?.length!==0||plan.allocations?.length!==0||plan.policyBlocked)throw Error('Matching engine proposed a trade or blocked allocation');
 const unmatched=output.unmatchedBuyerIds;
 if(!Array.isArray(unmatched)||unmatched.length!==b.length||new Set(unmatched).size!==b.length||
    unmatched.some(x=>!b.some(u=>u.userId===x)))throw Error('Unmatched buyers must equal exactly the buyers');
 if(!Array.isArray(plan.positions)||plan.positions.length!==12||plan.positions.some(p=>p.matchedWh!=='0'))throw Error('Zero-seller replay has nonzero energy allocation');
 return {buyers:b.length,sellers:0,unmatched:b.length,matchCount:0};
}
export function reviewDigest(review){
 if(review?.version!=='B35_ZERO_MATCH_REPLAY_V1'||review?.day!==B35_DAY||review?.rows?.length!==8)throw Error('Invalid B35 manifest');
 const slots=b35Slots();
 if(review.rows.some((r,i)=>r.slot!==slots[i]||!/^([a-f0-9]{64})$/.test(r.sourceSha256)||!/^([a-f0-9]{64})$/.test(r.importSha256)||
     !/^([a-f0-9]{64})$/.test(r.resultSha256)||!/^([a-f0-9]{64})$/.test(r.configSha256)||
     typeof r.snapshotId!=='string'||r.sellers!==0||r.matchCount!==0||r.buyers<1||r.unmatchedBuyers!==r.buyers))throw Error('Invalid B35 replay row');
 return '0x'+sha(stableJson({version:review.version,day:review.day,rows:review.rows.map(({existingState,...fixed})=>fixed)}));
}
export function assertApprovedReview(approved,recomputed){
 if(!approved||!recomputed||approved.reviewDigest!==reviewDigest(approved)||recomputed.reviewDigest!==reviewDigest(recomputed)||
    stableJson(approved.rows.map(({existingState,...fixed})=>fixed))!==stableJson(recomputed.rows.map(({existingState,...fixed})=>fixed)))throw Error('B35 approval is stale or changed; no writes permitted');
 return true;
}
export function verifyExistingRun(found,wanted,matchRows){
 if(!Array.isArray(matchRows)||matchRows.length!==0)throw Error('Unexpected existing matched trades in zero-seller hour');
 if(!found)return 'MISSING';
 if(found.snapshot_id!==wanted.snapshotId||new Date(found.time_slot).toISOString()!==wanted.slot.replace('Z','.000Z')||
    found.algorithm_version!==wanted.algorithmVersion||found.config_sha256!==wanted.configSha256||
    found.result_sha256!==wanted.resultSha256||Number(found.match_count)!==0||
    Number(found.unmatched_buyer_count)!==wanted.unmatchedBuyers)throw Error('Existing matching run conflicts with replay evidence');
 return 'IDENTICAL_EXISTING';
}
