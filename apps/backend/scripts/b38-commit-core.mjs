import {sha256} from './b38-day-core.mjs';
export function verifyApproval(approved,fresh,day,digest){
 if(approved?.format!=='MGL850_B38_PREVIEW_V1'||approved.day!==day||approved.reviewDigest!==digest||!/^0x[0-9a-f]{64}$/.test(digest))throw Error('Review identity or explicit digest mismatch');
 const {reviewDigest,...body}=approved;
 if('0x'+sha256(JSON.stringify(body))!==digest||JSON.stringify(approved)!==JSON.stringify(fresh))throw Error('Reviewed financial terms changed');
}
export function assertMeasurements(positions,rows){
 const byId=new Map(rows.map(r=>[r.userId,r]));
 if(positions.length!==12||rows.length!==12||byId.size!==12||new Set(positions.map(p=>p.userId)).size!==12)throw Error('Expected 12 distinct measurements');
 for(const p of positions){const r=byId.get(p.userId);if(!r||String(r.productionWh)!==String(p.productionWh)||String(r.consumptionWh)!==String(p.consumptionWh))throw Error('Stored measurement differs from reviewed source');}
}
