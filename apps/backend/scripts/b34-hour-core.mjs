/** B34: read-only market coverage classification. No blockchain writes. */
export function classifyHour({measurements, expectedHouseholds, b12Runs, b12Matches, v2Allocations, recordedProofs}) {
  for (const x of [measurements, expectedHouseholds, b12Runs, b12Matches, v2Allocations, recordedProofs]) {
    if (!Number.isSafeInteger(x) || x < 0) throw new Error('Invalid hourly count');
  }
  if (recordedProofs > v2Allocations) throw new Error('Proof count exceeds allocations');
  if (measurements !== expectedHouseholds) return 'INCOMPLETE_ENERGY_DATA';
  if (v2Allocations > 0) return recordedProofs === v2Allocations ? 'V2_RECORDED_FULLY_SETTLED' : 'V2_NEEDS_RECONCILIATION';
  if (b12Matches > 0) return 'HISTORICAL_MATCHES_NOT_AUTHORIZED';
  if (b12Runs > 0) return 'B12_MATCHING_COMPLETED_ZERO_MATCHES';
  return 'NO_B12_MATCHING_RUN';
}
export function isoDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Day must be YYYY-MM-DD');
  const d = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0,10) !== day) throw Error('Invalid UTC day');
  return d;
}
export function aggregateCoverage(hours) {
  if (!Array.isArray(hours) || hours.length !== 24 || new Set(hours.map(x=>x.hourUTC)).size !== 24) throw Error('Coverage must contain 24 distinct UTC hours');
  return {
    importedHours: hours.filter(x=>x.measurements===x.expectedHouseholds).length,
    b12RunHours: hours.filter(x=>x.b12Runs>0).length,
    hoursWithoutB12Run: hours.filter(x=>x.b12Runs===0).length,
    b12Matches: hours.reduce((n,x)=>n+x.b12Matches,0),
    v2TradingHours: hours.filter(x=>x.v2Allocations>0).length,
    v2Allocations: hours.reduce((n,x)=>n+x.v2Allocations,0),
    recordedProofs: hours.reduce((n,x)=>n+x.recordedProofs,0),
    recordedTeusdBaseUnits: hours.reduce((n,x)=>n+BigInt(x.recordedTeusdBaseUnits),0n).toString(),
    requiresAttention: hours.filter(x=>['INCOMPLETE_ENERGY_DATA','V2_NEEDS_RECONCILIATION','HISTORICAL_MATCHES_NOT_AUTHORIZED','NO_B12_MATCHING_RUN'].includes(x.state)).map(x=>x.hourUTC),
  };
}
export function ledgerFlows(households,allocations) {
  const flows = new Map(households.map(x=>[x.userId,{userId:x.userId,name:x.name,address:x.address,boughtWh:0n,soldWh:0n,spent:0n,earned:0n,trades:0}]));
  const ids=new Set();
  for(const a of allocations){
    if(ids.has(a.id)) throw Error('Duplicate allocation in ledger');ids.add(a.id);
    if(a.buyerId===a.sellerId)throw Error('Self-trade in ledger');
    const buyer=flows.get(a.buyerId), seller=flows.get(a.sellerId);
    if(!buyer||!seller) throw Error('Unregistered household in allocation');
    if(String(buyer.address).toLowerCase()!==String(a.buyerAddress).toLowerCase()||String(seller.address).toLowerCase()!==String(a.sellerAddress).toLowerCase())throw Error('Unexpected wallet identity');
    const amount=BigInt(a.amountBaseUnits),wh=BigInt(a.quantityWh);
    if(amount<=0n||wh<=0n)throw Error('Invalid energy transfer');
    buyer.boughtWh+=wh;buyer.spent+=amount;buyer.trades++;
    seller.soldWh+=wh;seller.earned+=amount;seller.trades++;
  }
  const rows=[...flows.values()].map(f=>({userId:f.userId,name:f.name,address:f.address,boughtWh:f.boughtWh.toString(),soldWh:f.soldWh.toString(),spentBaseUnits:f.spent.toString(),earnedBaseUnits:f.earned.toString(),netTradeFlowBaseUnits:(f.earned-f.spent).toString(),trades:f.trades}));
  const spent=rows.reduce((s,x)=>s+BigInt(x.spentBaseUnits),0n),earned=rows.reduce((s,x)=>s+BigInt(x.earnedBaseUnits),0n);
  if(spent!==earned)throw Error('TEUSD ledger does not conserve value');
  return rows;
}
