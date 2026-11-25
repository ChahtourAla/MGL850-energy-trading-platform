import B27OnchainVerification from './B27OnchainVerification';
import { buildHouseholdOverview, type Household, type HouseholdTrade, type HouseholdResult } from './b30-household-model';

async function readApi<T>(path: string): Promise<T> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  if (!base || !key) throw new Error('Dashboard backend/read-key configuration missing');
  const response=await fetch(new URL(path,base),{
    headers: {'x-trading-read-key':key}, cache:'no-store', signal:AbortSignal.timeout(12000),
  });
  if(!response.ok) throw new Error(`Backend HTTP ${response.status}`);
  return await response.json() as T;
}
function fmtEnergy(wh:string) {
  if(!/^\d+$/.test(wh)) return 'Unknown';
  const n=BigInt(wh);return `${n/BigInt(1000)}.${String(n%BigInt(1000)).padStart(3,'0')} kWh`;
}
function fmtTeusd(value:string) {
  if(!/^\d+$/.test(value)) return 'Unknown';
  const n=BigInt(value);return `${n/BigInt(1000000)}.${String(n%BigInt(1000000)).padStart(6,'0')} TEUSD`;
}
export default async function B30AllHouseholds({from,to}:{from:string;to:string}) {
  let users: Household[]=[];
  try {users=(await readApi<{users:Household[]}>('/internal/v2/demo/users')).users;}
  catch {return <section className="rounded-xl border border-amber-900/60 bg-slate-900 p-5 text-amber-200">All-household settlement overview unavailable. Verify backend and read credentials.</section>;}
  // Use existing guarded API. Do not query DB directly from Next.js or expose the read key.
  const responses=await Promise.all(users.map(async (u):Promise<HouseholdResult>=>{
    try {
      const query=new URLSearchParams({from,to,limit:'50',offset:'0'});
      const result=await readApi<{trades:HouseholdTrade[];pagination:{hasMore:boolean}}>(`/internal/v2/demo/users/${encodeURIComponent(u.userId)}/trades?${query}`);
      return {userId:u.userId,trades:result.trades,hasMore:result.pagination.hasMore,failed:false};
    } catch {return {userId:u.userId,trades:[],hasMore:false,failed:true};}
  }));
  const overview=buildHouseholdOverview(users,responses);
  return <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
    <header className="border-b border-slate-800 p-5">
      <h3 className="text-xl font-semibold">All-household energy payments</h3>
      <p className="mt-2 text-sm text-slate-400">All {users.length} simulated households. Only matched energy allocations create payments. A transaction link appears only after independent Hedera confirmation.</p>
      {!overview.complete && <p className="mt-2 text-amber-300 text-xs">Some household records could not be retrieved or have more than 50 trades. Totals may be incomplete.</p>}
    </header>
    <div className="grid gap-2 border-b border-slate-800 p-5 sm:grid-cols-2 lg:grid-cols-4">
      {overview.householdStates.map(h=><div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2" key={h.userId}>
        <p className="font-medium text-sm">{h.name}</p>
        <p className={h.status==='MATCHED'?'mt-1 text-xs text-emerald-300':'mt-1 text-xs text-slate-400'}>
          {h.status==='UNAVAILABLE'?'Data unavailable':h.status==='PARTIAL'?'More trades exist':h.status==='NO_MATCH'?'No matched energy trade':`${h.matches} matched trade${h.matches===1?'':'s'}`}
        </p>
      </div>)}
    </div>
    {overview.trades.length===0?<p className="p-5 text-sm text-slate-400">No verified authoritative allocations found for this time interval. No payments should be invented.</p>:
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="bg-slate-800 text-slate-300"><tr>{['Buyer','Seller','Energy','Expected payment','Recorded state / independently verified transaction'].map(h=><th key={h} className="p-4">{h}</th>)}</tr></thead>
      <tbody>{overview.trades.map(({ownerId,buyerName,sellerName,trade})=><tr key={trade.allocationId} className="border-t border-slate-800 align-top">
        <td className="p-4">{buyerName}</td><td className="p-4">{sellerName}</td>
        <td className="p-4 whitespace-nowrap">{fmtEnergy(trade.quantityWh)}</td>
        <td className="p-4 whitespace-nowrap">{fmtTeusd(trade.expectedPaymentBaseUnits)}</td>
        <td className="p-4 min-w-80">
          <p className="text-xs text-slate-400">Database: {trade.paymentStatus.replaceAll('_',' ')}</p>
          <B27OnchainVerification userId={ownerId} allocationId={trade.allocationId} network={trade.network==='LOCAL_HARDHAT'?'LOCAL_HARDHAT':'HEDERA_TESTNET'} />
        </td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
