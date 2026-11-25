/** UTC-day coverage: absence of a B12 run != zero eligible matches. */
type Hour = {hourUTC:string;measurements:number;expectedHouseholds:number;b12Runs:number;b12Matches:number;b12ReportedMatchCount:number;v2Allocations:number;recordedProofs:number;recordedTeusdBaseUnits:string;matchedBuyerCount:number;matchedSellerCount:number;state:string;b26Runs:{configuration:string;status:string;failureCode:string|null}[]};
type Coverage = {utcDay:string;expectedHouseholds:number;summary:{importedHours:number;b12RunHours:number;hoursWithoutB12Run:number;b12Matches:number;v2TradingHours:number;v2Allocations:number;recordedProofs:number;recordedTeusdBaseUnits:string;requiresAttention:string[]};hours:Hour[];evidenceLevel:string};
function tokens(base: string):string {
  if(!/^\d+$/.test(base))return 'Unavailable';
  const v=BigInt(base);return `${v/BigInt(1000000)}.${String(v%BigInt(1000000)).padStart(6,'0')}`;
}
const description:Record<string,string>={
 INCOMPLETE_ENERGY_DATA:'Energy data incomplete',
 V2_RECORDED_FULLY_SETTLED:'V2 with recorded payment evidence',
 V2_NEEDS_RECONCILIATION:'V2 settlement needs verification',
 HISTORICAL_MATCHES_NOT_AUTHORIZED:'Historical matches not V2-authorized',
 B12_MATCHING_COMPLETED_ZERO_MATCHES:'B12 matching ran: zero matches',
 NO_B12_MATCHING_RUN:'No historical B12 matching run',
};
export default async function B34DayCoveragePanel({day}:{day:string}) {
  const base=process.env.B27_BACKEND_URL,key=process.env.TRADING_API_READ_ADMIN_KEY;
  if(!base||!key)return <section className="rounded-xl border border-amber-900 bg-slate-900 p-5 text-amber-200">Full-day verification unavailable: backend/read-only key is missing.</section>;
  let info:Coverage;
  try {
    const path=`/internal/v2/demo/day-coverage?${new URLSearchParams({day})}`;
    const response=await fetch(new URL(path,base),{headers:{'x-trading-read-key':key},cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    info=await response.json() as Coverage;
    if(info.utcDay!==day||info.hours.length!==24||info.evidenceLevel!=='DATABASE_RECORDED_ONLY')throw Error('Invalid coverage response');
  } catch {
    return <section className="rounded-xl border border-amber-900 bg-slate-900 p-5 text-amber-200">24-hour verification overview unavailable. Check that the B34 backend is installed, restarted, and accessible.</section>;
  }
  const s=info.summary;
  return <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
    <header className="border-b border-slate-800 p-5">
      <h3 className="text-xl font-semibold">24-hour market verification · {day} UTC</h3>
      <p className="mt-2 text-sm text-slate-400">Energy measurements, historical matching runs, authoritative V2 allocations, and database-recorded settlement evidence for all simulated households.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['Complete energy hours',`${s.importedHours}/24`],['Hours with a B12 run',`${s.b12RunHours}/24`],['Authoritative allocations',String(s.v2Allocations)],['Recorded payment evidence',`${s.recordedProofs}/${s.v2Allocations}`]].map(([label,value])=><div key={label} className="rounded-lg bg-slate-800/60 p-3"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>)}
      </div>
      <p className="mt-3 text-xs text-amber-200">Database payment records are not independent blockchain verification. Use each trade’s on-chain proof link, and run the read-only B34 Hedera audit for a full-day check.</p>
    </header>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-800 text-slate-300"><tr>{['Hour UTC','Readings','B12 runs','B12 matches','V2 trades','Payment records','TEUSD recorded','Status'].map(k=><th className="whitespace-nowrap px-3 py-3" key={k}>{k}</th>)}</tr></thead>
        <tbody>{info.hours.map(x=><tr key={x.hourUTC} className="border-t border-slate-800">
          <td className="px-3 py-2 font-medium">{x.hourUTC.slice(11,16)}</td>
          <td className="px-3 py-2">{x.measurements}/{x.expectedHouseholds}</td>
          <td className="px-3 py-2">{x.b12Runs}</td>
          <td className="px-3 py-2">{x.b12Matches}</td>
          <td className="px-3 py-2">{x.v2Allocations}</td>
          <td className="px-3 py-2">{x.recordedProofs}</td>
          <td className="px-3 py-2">{tokens(x.recordedTeusdBaseUnits)}</td>
          <td className="px-3 py-2"><span className={x.state==='V2_RECORDED_FULLY_SETTLED'?'text-emerald-300':x.state==='B12_MATCHING_COMPLETED_ZERO_MATCHES'?'text-slate-400':'text-amber-300'}>{description[x.state]??'Needs inspection'}</span>{x.b26Runs.length>0&&<p className="mt-1 text-slate-500">B26: {x.b26Runs.map(r=>r.status).join(', ')}</p>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="p-4 text-xs text-slate-400">No B12 run means matching coverage is unconfirmed, not that a payment is missing. A zero-match run is a separate outcome. Live wallet balance is available under each selected household’s wallet panel.</p>
  </section>;
}
