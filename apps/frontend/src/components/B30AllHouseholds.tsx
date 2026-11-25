import B27OnchainVerification from './B27OnchainVerification';
import {
  buildHouseholdOverview,
  type Household,
  type HouseholdTrade,
  type HouseholdResult,
} from './b30-household-model';

async function readApi<T>(path: string): Promise<T> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  if (!base || !key) throw new Error('Read-only dashboard configuration missing');
  const response = await fetch(new URL(path, base), {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
  return (await response.json()) as T;
}

function number(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) return 'Unavailable';
  const n = BigInt(value);
  const scale = BigInt(10) ** BigInt(decimals);
  return `${n / scale}.${String(n % scale).padStart(decimals, '0')}`;
}

export default async function B30AllHouseholds({ from, to }: { from: string; to: string }) {
  let users: Household[];
  try {
    users = (await readApi<{ users: Household[] }>('/internal/v2/demo/users')).users;
  } catch {
    return <p className="text-sm text-amber-200">Community trading activity is temporarily unavailable.</p>;
  }

  const responses = await Promise.all(users.map(async (user): Promise<HouseholdResult> => {
    try {
      const query = new URLSearchParams({ from, to, limit: '50', offset: '0' });
      const result = await readApi<{ trades: HouseholdTrade[]; pagination: { hasMore: boolean } }>(
        `/internal/v2/demo/users/${encodeURIComponent(user.userId)}/trades?${query}`,
      );
      return { userId: user.userId, trades: result.trades, hasMore: result.pagination.hasMore, failed: false };
    } catch {
      return { userId: user.userId, trades: [], hasMore: false, failed: true };
    }
  }));

  const overview = buildHouseholdOverview(users, responses);
  const active = overview.householdStates.filter(h => h.status === 'MATCHED').length;

  return (
    <div>
      <h3 className="text-lg font-semibold">Community trading activity</h3>
      <p className="mt-2 text-sm text-slate-400">
        See which simulated households took part in recorded electricity trades during these dates.
      </p>
      {!overview.complete && <p className="mt-3 text-xs text-amber-200">Some household records could not be loaded or have additional pages. This summary may be incomplete.</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {overview.householdStates.map(h => (
          <div key={h.userId} className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3">
            <p className="text-sm font-medium">{h.name}</p>
            <p className={`mt-1 text-xs ${h.status === 'MATCHED' ? 'text-emerald-300' : 'text-slate-400'}`}>
              {h.status === 'UNAVAILABLE' ? 'Data unavailable' :
                h.status === 'PARTIAL' ? 'Additional trades available' :
                h.status === 'NO_MATCH' ? 'No recorded trades' :
                `${h.matches} trade${h.matches === 1 ? '' : 's'}`}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">{active} of {users.length} households have a recorded trade in this selection.</p>
      {overview.trades.length > 0 && (
        <details className="mt-5 rounded-xl border border-slate-700/60 bg-slate-900/40">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-300">
            See all community trades ({overview.trades.length})
          </summary>
          <div className="overflow-x-auto border-t border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-800/70 text-slate-300">
                <tr>{['Buyer', 'Seller', 'Electricity', 'Trade amount', 'Payment'].map(label => (
                  <th scope="col" key={label} className="px-4 py-3 font-medium">{label}</th>
                ))}</tr>
              </thead>
              <tbody>
                {overview.trades.map(({ ownerId, buyerName, sellerName, trade }) => (
                  <tr key={trade.allocationId} className="border-t border-slate-800/80 align-top">
                    <td className="px-4 py-3">{buyerName}</td>
                    <td className="px-4 py-3">{sellerName}</td>
                    <td className="whitespace-nowrap px-4 py-3">{number(trade.quantityWh, 3)} kWh</td>
                    <td className="whitespace-nowrap px-4 py-3">{number(trade.expectedPaymentBaseUnits, 6)} TEUSD</td>
                    <td className="px-4 py-3">
                      <B27OnchainVerification userId={ownerId} allocationId={trade.allocationId} network={trade.network} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
