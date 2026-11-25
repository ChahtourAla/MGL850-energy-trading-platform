/** B32 pure full-day authorization gate. No network, secrets, database or writes. */
import {quoteTeusd, B28_POLICY} from './b28-teusd-quantization.mjs';
const asBig = (x, field) => {
  const s=String(x);
  if(x===null||x===undefined||!/^-?(?:0|[1-9]\d*)$/.test(s))throw Error(`Invalid ${field}`);
  return BigInt(s);
};
const evm = x => typeof x==='string' && /^0x[0-9a-f]{40}$/i.test(x);
const uuid = x => typeof x==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail = (errors,code) => {if(!errors.includes(code))errors.push(code);};
export function inspectHour({slot,imports=[],records=[],matchingRuns=[],matches=[],wallets=[],v2Markets=[],v2Allocations=[]}) {
  const errors=[],warnings=[];
  if(imports.length!==1)fail(errors,'EXPECTED_ONE_TRUSTED_B11_IMPORT');
  if(records.length!==12)fail(errors,'EXPECTED_12_IMPORTED_HOUSEHOLDS');
  if(imports[0]&&(Number(imports[0].record_count)!==12 || imports[0].schema_version!=='1.0.0'||imports[0].generator_version!=='1.0.0'))fail(errors,'IMPORT_METADATA_INVALID');
  if(matchingRuns.length>1)fail(errors,'MULTIPLE_B12_RUNS');
  if(matches.length && matchingRuns.length!==1)fail(errors,'B12_MATCHES_WITHOUT_UNIQUE_RUN');
  if(matchingRuns.length===1){
    if(Number(matchingRuns[0].match_count)!==matches.length)fail(errors,'B12_RUN_COUNT_MISMATCH');
    if(matchingRuns[0].snapshot_id!==imports[0]?.id)fail(errors,'B12_SNAPSHOT_REFERENCE_MISMATCH');
  }
  if(v2Markets.length>1)fail(errors,'MULTIPLE_V2_MARKETS');
  if(v2Allocations.length&&!v2Markets.length)fail(errors,'ORPHAN_V2_ALLOCATIONS');
  const byUser=new Map(), wByUser=new Map(), seenWallets=new Set();
  for(const w of wallets){
    const id=String(w.user_id??''),address=String(w.evm_address??'').toLowerCase();
    if(!uuid(id)||!evm(address)||wByUser.has(id)||seenWallets.has(address))fail(errors,'INVALID_OR_DUPLICATE_WALLET');
    wByUser.set(id,w);seenWallets.add(address);
  }
  for(const r of records){
    if(!uuid(r.user_id)||byUser.has(r.user_id))fail(errors,'DUPLICATE_OR_INVALID_HOUSEHOLD');
    byUser.set(r.user_id,r);
    if(!wByUser.has(r.user_id))fail(errors,'HOUSEHOLD_WALLET_MISSING');
    if(imports[0]&&r.snapshot_id!==imports[0].id)fail(errors,'ENERGY_SNAPSHOT_REFERENCE_MISMATCH');
    try{
      const production=asBig(r.production_wh,'production'),consumption=asBig(r.consumption_wh,'consumption'),net=asBig(r.net_energy_wh,'net');
      if(production<0n||consumption<0n||net!==production-consumption)fail(errors,'ENERGY_CONSERVATION_INVALID');
      if(net>0n && (r.market_role!=='SELLER'||asBig(r.available_energy_wh,'available')!==net))fail(errors,'SELLER_POSITION_INVALID');
      if(net<0n && (r.market_role!=='BUYER'||asBig(r.required_energy_wh,'required')!==-net))fail(errors,'BUYER_POSITION_INVALID');
      if(net===0n && r.market_role!=='NEUTRAL')fail(errors,'NEUTRAL_POSITION_INVALID');
    }catch{fail(errors,'ENERGY_QUANTITY_INVALID');}
  }
  const buyTotals=new Map(), sellTotals=new Map(), seenBuyers=new Set(), rows=[];
  for(const m of matches){
    const b=byUser.get(m.buyer_id),s=byUser.get(m.seller_id);
    if(!b||!s||m.buyer_id===m.seller_id||b.market_role!=='BUYER'||s.market_role!=='SELLER')fail(errors,'INVALID_BUYER_SELLER_MATCH');
    if(!b||!s)continue;
    if(seenBuyers.has(m.buyer_id))fail(errors,'MULTIPLE_SELLERS_FOR_BUYER');
    seenBuyers.add(m.buyer_id);
    if(m.status!=='SELECTED')fail(errors,'NON_SELECTED_HISTORICAL_MATCH');
    if(s.energy_type!==m.seller_energy_type)fail(errors,'ENERGY_TYPE_CHANGED');
    try{
      const q=asBig(m.quantity_wh,'quantity'),price=asBig(m.unit_price_microusd_per_kwh,'price');
      if(q<=0n||price<=0n || price!==asBig(s.ask_price_microusd_per_kwh,'ask') || price>asBig(b.max_price_microusd_per_kwh,'max'))fail(errors,'MATCH_PRICE_INVALID');
      buyTotals.set(m.buyer_id,(buyTotals.get(m.buyer_id)??0n)+q);
      sellTotals.set(m.seller_id,(sellTotals.get(m.seller_id)??0n)+q);
      const rounded=quoteTeusd({quantityWh:q.toString(),unitPriceMicrousdPerKwh:price.toString(),policy:B28_POLICY});
      const amount=rounded.amountBaseUnits;
      if(BigInt(amount)>9223372036854775807n)fail(errors,'PAYMENT_POSTGRES_OVERFLOW');
      // Historical V1 payment fields are NOT the B28 half-even authority.
      // Their numerical differences must never be silently written or paid.
      const historical=asBig(m.total_amount_microusd,'historic-amount');
      if(historical!==BigInt(amount))fail(warnings,'HALF_EVEN_REPRICING_REQUIRED');
      rows.push({matchId:m.id,buyerId:m.buyer_id,sellerId:m.seller_id,quantityWh:q.toString(),priceMicrousdPerKwh:price.toString(),b12AmountBaseUnits:historical.toString(),b28PreviewAmountBaseUnits:amount,priceRemainder:rounded.remainderOf1000});
    }catch{fail(errors,'MATCH_PAYMENT_INVALID');}
  }
  for(const [id,total] of buyTotals){
    const b=byUser.get(id);
    try{if(total!==asBig(b.required_energy_wh,'buyer-required'))fail(errors,'BUYER_NOT_FULLY_SATISFIED');}
    catch{fail(errors,'BUYER_REQUIRED_INVALID');}
  }
  for(const [id,total] of sellTotals){
    const s=byUser.get(id);
    try{if(total>asBig(s.available_energy_wh,'seller-capacity'))fail(errors,'SELLER_OVERALLOCATED');}
    catch{fail(errors,'SELLER_CAPACITY_INVALID');}
  }
  let state;
  if(errors.length)state='BLOCKED';
  else if(v2Markets.length)state='EXISTING_V2_RECONCILE_ONLY';
  else if(!matchingRuns.length)state='NO_B12_RUN';
  else if(!matches.length)state='NO_B12_MATCH';
  else state='ORIGINAL_B11_REPLAY_REQUIRED';
  return {slot,state,records:records.length,matchingRuns:matchingRuns.length,legacyMatches:matches.length,v2Markets:v2Markets.length,v2Allocations:v2Allocations.length,provisionalBaseUnits:rows.reduce((a,r)=>a+BigInt(r.b28PreviewAmountBaseUnits),0n).toString(),matchesForReview:rows,errors,warnings};
}
export function summarizeDay(hours){
 if(hours.length!==24||new Set(hours.map(x=>x.slot)).size!==24)throw Error('Expected 24 distinct UTC hours');
 return {hours:hours.length,importedHours:hours.filter(x=>x.records===12).length,historicalMatches:hours.reduce((n,x)=>n+x.legacyMatches,0),existingV2Hours:hours.filter(x=>x.v2Markets>0).length,hoursNeedingReplay:hours.filter(x=>x.state==='ORIGINAL_B11_REPLAY_REQUIRED').length,blockedHours:hours.filter(x=>x.state==='BLOCKED').length};
}
