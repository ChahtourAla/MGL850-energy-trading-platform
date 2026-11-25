type Match = {
  matchId: string;
  timeSlot: string;
  side: 'BUYER' | 'SELLER';
  counterparty: { userId: string; name: string };
  quantityWh: string;
  unitPriceMicrousdPerKwh: string;
  quotedTotalMicrousd: string;
};

type MatchingHistory = { matches: Match[]; hasMore: boolean };

function fixed(value: string, decimals: number): string {
  if (!/^-?\d+$/.test(value)) return 'Unavailable';
  const n = BigInt(value);
  const scale = BigInt(10) ** BigInt(decimals);
  const abs = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${abs / scale}.${String(abs % scale).padStart(decimals, '0')}`;
}

export default async function MatchingHistoryPanel({ userId, from, to }: { userId: string; from: string; to: string }) {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  let history: MatchingHistory | null = null;

  if (base && key) {
    try {
      const query = new URLSearchParams({ from, to });
      const path = `/internal/v2/demo/users/${encodeURIComponent(userId)}/matches?${query}`;
      const response = await fetch(new URL(path, base), {
        headers: { 'x-trading-read-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) history = (await response.json()) as MatchingHistory;
    } catch {
      // Present unavailable data as unavailable, never as zero matches.
    }
  }

  if (!history) {
    return <p className="p-4 text-sm text-amber-200">Potential matches could not be loaded. Try again later.</p>;
  }

  return (
    <div>
      <h3 className="text-lg font-semibold">Potential energy matches</h3>
      <p className="mt-2 text-sm text-slate-400">
        The platform suggests buyers and sellers with compatible energy needs. A match is not a completed payment; verified payments appear in Trading History above.
      </p>
      {history.matches.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-800/40 p-4 text-sm text-slate-400">No potential matches for this household during these dates.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-700/60">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Potential matches, which do not themselves prove payment</caption>
            <thead className="bg-slate-800/80 text-slate-300">
              <tr>
                {['Time (UTC)', 'Action', 'Matched with', 'Electricity', 'Est. price / kWh', 'Est. amount'].map(label => (
                  <th scope="col" key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.matches.map(match => (
                <tr key={match.matchId} className="border-t border-slate-800/80">
                  <td className="whitespace-nowrap px-4 py-3">{match.timeSlot.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-3">{match.side === 'BUYER' ? 'Buy' : 'Sell'}</td>
                  <td className="px-4 py-3">{match.counterparty.name}</td>
                  <td className="whitespace-nowrap px-4 py-3">{fixed(match.quantityWh, 3)} kWh</td>
                  <td className="whitespace-nowrap px-4 py-3">{fixed(match.unitPriceMicrousdPerKwh, 6)} TEUSD</td>
                  <td className="whitespace-nowrap px-4 py-3">{fixed(match.quotedTotalMicrousd, 6)} TEUSD</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.hasMore && <p className="border-t border-slate-800 p-4 text-xs text-slate-400">Showing the latest 50 matches.</p>}
        </div>
      )}
    </div>
  );
}
