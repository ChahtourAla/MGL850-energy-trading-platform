import {createHash} from 'node:crypto';
export const sha256 = x => createHash('sha256').update(x).digest('hex');
export function slots(day,now=Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day??'')) throw Error('Expected UTC day YYYY-MM-DD');
  const t=Date.parse(day+'T00:00:00Z');
  if (!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==day||t+86400000>now) throw Error('Invalid or not fully closed UTC day');
  return Array.from({length:24},(_,i)=>`${day}T${String(i).padStart(2,'0')}:00:00Z`);
}
export function checkManifest(m,day) {
  const expected=slots(day);
  if(m?.format!=='MGL850_NEW_DAY_PREVIEW_V1'||m.day!==day||m.expectedUsers!==12||m.hours?.length!==24) throw Error('Invalid original daily manifest');
  expected.forEach((slot,i)=>{const h=m.hours[i];if(h.timeSlot!==slot||h.filename!==`hour-${slot.slice(11,13)}.json`||h.total!==12||!/^[a-f0-9]{64}$/.test(h.sha256))throw Error(`Invalid manifest hour ${slot}`);});
  return m.hours;
}
export function checkParity(rows,allocations) {
  const key=(b,s,q,p)=>JSON.stringify([b,s,String(q),String(p)]);
  if(rows.some(r=>r.status!=='SELECTED'))throw Error('B12 match not SELECTED');
  const a=rows.map(r=>key(r.buyer_id,r.seller_id,r.quantity_wh,r.unit_price_microusd_per_kwh)).sort();
  const b=allocations.map(r=>key(r.buyerId,r.sellerId,r.quantityWh,r.unitPriceMicrousdPerKwh)).sort();
  if(new Set(a).size!==a.length||new Set(b).size!==b.length||JSON.stringify(a)!==JSON.stringify(b))throw Error('B12/V2 economic parity failed');
}
export function review(day,hours,configHash,sourceManifestSha256) {
  const expected=slots(day);
  if(hours.length!==24||hours.some((h,i)=>h.slot!==expected[i]||h.matchCount!==(h.market?.allocations.length??0)))throw Error('Incomplete daily review');
  const allocations=hours.flatMap(h=>h.market?.allocations??[]);
  if(new Set(allocations.map(a=>a.id)).size!==allocations.length)throw Error('Duplicate allocation ID');
  const totals=new Map();for(const a of allocations) totals.set(a.buyerAddress,(totals.get(a.buyerAddress)??0n)+BigInt(a.amountBaseUnits));
  const body={format:'MGL850_B38_PREVIEW_V1',day,configHash,sourceManifestSha256,hours,summary:{energyHours:24,matchingHours:24,tradingHours:hours.filter(h=>h.matchCount>0).length,allocations:allocations.length,totalBaseUnits:allocations.reduce((n,a)=>n+BigInt(a.amountBaseUnits),0n).toString(),grossBuyerRequirements:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([buyerAddress,v])=>({buyerAddress,amountBaseUnits:String(v)}))}};
  return {...body,reviewDigest:'0x'+sha256(JSON.stringify(body))};
}
