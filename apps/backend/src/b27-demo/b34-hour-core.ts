/** B34 read-only UTC-day status classification. Backend runtime TS version. */
export type B34Stats = {
  measurements: number; expectedHouseholds: number; b12Runs: number; b12Matches: number;
  v2Allocations: number; recordedProofs: number;
};
export type B34Hour = B34Stats & {hourUTC:string;recordedTeusdBaseUnits:string;state:string};
export function classifyHour(s: B34Stats): string {
  for(const x of Object.values(s)) if(!Number.isSafeInteger(x)||x<0) throw Error('Invalid hourly count');
  if(s.recordedProofs>s.v2Allocations)throw Error('Proof count exceeds allocations');
  if(s.measurements!==s.expectedHouseholds)return 'INCOMPLETE_ENERGY_DATA';
  if(s.v2Allocations>0)return s.recordedProofs===s.v2Allocations?'V2_RECORDED_FULLY_SETTLED':'V2_NEEDS_RECONCILIATION';
  if(s.b12Matches>0)return 'HISTORICAL_MATCHES_NOT_AUTHORIZED';
  if(s.b12Runs>0)return 'B12_MATCHING_COMPLETED_ZERO_MATCHES';
  return 'NO_B12_MATCHING_RUN';
}
export function isoDay(day:unknown):Date {
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Day must be YYYY-MM-DD');
  const d=new Date(`${day}T00:00:00.000Z`);
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)throw Error('Invalid UTC day');
  return d;
}
export function aggregateCoverage(hours:B34Hour[]) {
  if(hours.length!==24||new Set(hours.map(x=>x.hourUTC)).size!==24)throw Error('Coverage must contain 24 distinct UTC hours');
  return {
    importedHours:hours.filter(x=>x.measurements===x.expectedHouseholds).length,
    b12RunHours:hours.filter(x=>x.b12Runs>0).length,
    hoursWithoutB12Run:hours.filter(x=>x.b12Runs===0).length,
    b12Matches:hours.reduce((n,x)=>n+x.b12Matches,0),
    v2TradingHours:hours.filter(x=>x.v2Allocations>0).length,
    v2Allocations:hours.reduce((n,x)=>n+x.v2Allocations,0),
    recordedProofs:hours.reduce((n,x)=>n+x.recordedProofs,0),
    recordedTeusdBaseUnits:hours.reduce((n,x)=>n+BigInt(x.recordedTeusdBaseUnits),0n).toString(),
    requiresAttention:hours.filter(x=>['INCOMPLETE_ENERGY_DATA','V2_NEEDS_RECONCILIATION','HISTORICAL_MATCHES_NOT_AUTHORIZED','NO_B12_MATCHING_RUN'].includes(x.state)).map(x=>x.hourUTC),
  };
}
