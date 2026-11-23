type Match = {
  matchId: string;
  timeSlot: string;
  side: 'BUYER' | 'SELLER';
  counterparty: {
    userId: string;
    name: string;
  };
  quantityWh: string;
  unitPriceMicrousdPerKwh: string;
  quotedTotalMicrousd: string;
  energyType: string;
  matchingStatus: string;
  trade: {
    tradeId: string;
    status: string;
  } | null;
  paymentVerification: string;
};

type MatchingHistory = {
  matches: Match[];
  hasMore: boolean;
};

function formatDecimal(input: string, decimals: number): string {
  const value = BigInt(input);
  const divisor = BigInt(10) ** BigInt(decimals);
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;

  return `${negative ? '-' : ''}${absolute / divisor}.${String(absolute % divisor).padStart(
    decimals,
    '0',
  )}`;
}

async function getMatchingHistory(
  userId: string,
  from: string,
  to: string,
): Promise<MatchingHistory> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;

  if (!base || !key) {
    throw new Error('Backend configuration missing');
  }

  const query = new URLSearchParams({ from, to });

  const path =
    `/internal/v2/demo/users/${encodeURIComponent(userId)}` + `/matches?${query.toString()}`;

  const response = await fetch(new URL(path, base), {
    headers: {
      'x-trading-read-key': key,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Matching history HTTP ${response.status}`);
  }

  return (await response.json()) as MatchingHistory;
}

export default async function MatchingHistoryPanel({
  userId,
  from,
  to,
}: {
  userId: string;
  from: string;
  to: string;
}) {
  let history: MatchingHistory;

  try {
    history = await getMatchingHistory(userId, from, to);
  } catch {
    return (
      <section className="rounded-xl border border-rose-800 bg-slate-900 p-5">
        <h3 className="text-xl font-semibold">Electricity Matching History</h3>
        <p className="mt-3 text-rose-300">
          Matching history is currently unavailable. Check the backend logs.
        </p>
      </section>
    );
  }

  const matchedBoughtWh = history.matches
    .filter((match) => match.side === 'BUYER')
    .reduce((total, match) => total + BigInt(match.quantityWh), BigInt(0));

  const matchedSoldWh = history.matches
    .filter((match) => match.side === 'SELLER')
    .reduce((total, match) => total + BigInt(match.quantityWh), BigInt(0));

  const quotedBought = history.matches
    .filter((match) => match.side === 'BUYER')
    .reduce((total, match) => total + BigInt(match.quotedTotalMicrousd), BigInt(0));

  const quotedSold = history.matches
    .filter((match) => match.side === 'SELLER')
    .reduce((total, match) => total + BigInt(match.quotedTotalMicrousd), BigInt(0));

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 p-5">
        <h3 className="text-xl font-semibold">Electricity Matching History</h3>
        <p className="mt-2 text-sm text-slate-400">
          Actual stored B12 matching results for the selected period. A match is not a confirmed
          energy payment.
        </p>
      </div>

      <div className="grid gap-4 border-b border-slate-800 p-5 md:grid-cols-2 xl:grid-cols-4">
        {[
          ['Matched buying', `${formatDecimal(matchedBoughtWh.toString(), 3)} kWh`],
          ['Matched selling', `${formatDecimal(matchedSoldWh.toString(), 3)} kWh`],
          ['Quoted buying value', `$${formatDecimal(quotedBought.toString(), 6)}`],
          ['Quoted selling value', `$${formatDecimal(quotedSold.toString(), 6)}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-800/60 p-4">
            <p className="text-sm text-slate-400">{label}</p>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </div>
        ))}

        {history.hasMore && (
          <p className="text-xs text-amber-300 md:col-span-2 xl:col-span-4">
            These totals include only the 50 displayed matches.
          </p>
        )}
      </div>
      {history.matches.length === 0 ? (
        <p className="p-6 text-sm text-slate-400">
          No electricity matches for this household and period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="p-4">UTC Time</th>
                <th className="p-4">Role</th>
                <th className="p-4">Counterparty</th>
                <th className="p-4">Energy</th>
                <th className="p-4">Price / kWh</th>
                <th className="p-4">Quoted Total</th>
                <th className="p-4">Match Status</th>
                <th className="p-4">Trade / Payment</th>
              </tr>
            </thead>

            <tbody>
              {history.matches.map((match) => (
                <tr key={match.matchId} className="border-t border-slate-800 align-top">
                  <td className="whitespace-nowrap p-4">
                    {match.timeSlot.replace('T', ' ').slice(0, 16)}
                  </td>

                  <td className="p-4">
                    <span className={match.side === 'SELLER' ? 'text-emerald-400' : 'text-sky-400'}>
                      {match.side === 'SELLER' ? 'Selling' : 'Buying'}
                    </span>
                  </td>

                  <td className="p-4">{match.counterparty.name}</td>

                  <td className="p-4">{formatDecimal(match.quantityWh, 3)} kWh</td>

                  <td className="p-4">${formatDecimal(match.unitPriceMicrousdPerKwh, 6)}</td>

                  <td className="p-4">${formatDecimal(match.quotedTotalMicrousd, 6)}</td>

                  <td className="p-4">{match.matchingStatus}</td>

                  <td className="p-4">
                    <p>
                      {match.trade
                        ? `Trade recorded: ${match.trade.status}`
                        : 'Match only — no trade'}
                    </p>
                    <p className="mt-1 text-xs text-amber-300">Payment not verified</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {history.hasMore && (
            <p className="p-4 text-xs text-slate-400">
              Showing the latest 50 matches. Additional history is available.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
