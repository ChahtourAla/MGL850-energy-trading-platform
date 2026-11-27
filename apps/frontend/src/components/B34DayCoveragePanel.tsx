/** Human-facing summary of the backend's *database-recorded* 24-hour state. */
type Hour = {
  hourUTC: string;
  measurements: number;
  expectedHouseholds: number;
  b12Runs: number;
  b12Matches: number;
  v2Allocations: number;
  recordedProofs: number;
  recordedTeusdBaseUnits: string;
  state: string;
};
type Coverage = {
  utcDay: string;
  expectedHouseholds: number;
  summary: {
    importedHours: number;
    b12RunHours: number;
    hoursWithoutB12Run: number;
    v2TradingHours: number;
    v2Allocations: number;
    recordedProofs: number;
    requiresAttention: string[];
  };
  hours: Hour[];
  evidenceLevel: string;
};

type HourStatus = { label: string; className: string };

function describeHour(hour: Hour): HourStatus {
  if (hour.measurements !== hour.expectedHouseholds || hour.state === 'INCOMPLETE_ENERGY_DATA') {
    return { label: 'Energy data missing', className: 'text-amber-200' };
  }
  if (hour.state === 'V2_RECORDED_FULLY_SETTLED') {
    return { label: 'Payment recorded', className: 'text-emerald-300' };
  }
  if (hour.state === 'B12_MATCHING_COMPLETED_ZERO_MATCHES') {
    return { label: 'No trades this hour', className: 'text-slate-300' };
  }
  if (hour.state === 'HISTORICAL_MATCHES_NOT_AUTHORIZED' || (hour.b12Matches > 0 && hour.v2Allocations === 0)) {
    return { label: 'Matches proposed — not paid', className: 'text-amber-200' };
  }
  if (hour.state === 'NO_B12_MATCHING_RUN') {
    return { label: 'Not processed', className: 'text-amber-200' };
  }
  return { label: 'Needs review', className: 'text-amber-200' };
}

export default async function B34DayCoveragePanel({ day }: { day: string }) {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  let info: Coverage | null = null;

  if (base && key) {
    try {
      const path = `/internal/v2/demo/day-coverage?${new URLSearchParams({ day })}`;
      const response = await fetch(new URL(path, base), {
        headers: { 'x-trading-read-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
      const payload = (await response.json()) as Coverage;
      if (payload.utcDay !== day || payload.hours.length !== 24 || payload.evidenceLevel !== 'DATABASE_RECORDED_ONLY') {
        throw new Error('Invalid coverage response');
      }
      info = payload;
    } catch {
      // Do not replace an unavailable verification response with invented data.
    }
  }

  if (!info) {
    return (
      <section className="rounded-2xl border border-amber-900/60 bg-slate-900 p-6 text-sm text-amber-200">
        Daily trading overview is temporarily unavailable. Check the backend connection.
      </section>
    );
  }

  const summary = info.summary;
  const zeroTradeHours = info.hours.filter(h => h.b12Runs > 0 && h.b12Matches === 0).length;
  const proposedMatches = info.hours.reduce((total, h) => total + h.b12Matches, 0);
  const processingComplete = summary.b12RunHours === 24 && summary.importedHours === 24 && summary.hoursWithoutB12Run === 0;
  const cards = [
    ['Hours with energy data', `${summary.importedHours}/24`],
    ['Hours processed', `${summary.b12RunHours}/24`],
    ['Matches found', String(proposedMatches)],
    ['Hours without matches', String(zeroTradeHours)],
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900" aria-labelledby="daily-overview-title">
      <header className="border-b border-slate-800 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="daily-overview-title" className="text-xl font-semibold">Daily trading overview</h3>
            <p className="mt-1 text-sm text-slate-400">All 24 hours of {day} · UTC · All households</p>
          </div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${processingComplete ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-200'}`}>
            {processingComplete ? 'Day processed' : 'Some hours need attention'}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {cards.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-4">
              <p className="text-xs text-slate-400">{label}</p>
              <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          A match is a proposed energy exchange, not a payment. New simulation matches will appear here before any TEUSD settlement; only independently verified payments appear as Paid in trading history.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Hourly processing and trading results for {day} in UTC</caption>
          <thead className="bg-slate-800/80 text-slate-300">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium">Hour (UTC)</th>
              <th scope="col" className="px-5 py-3 font-medium">Energy readings</th>
              <th scope="col" className="px-5 py-3 font-medium">Matches</th>
              <th scope="col" className="px-5 py-3 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {info.hours.map(hour => {
              const result = describeHour(hour);
              return (
                <tr key={hour.hourUTC} className="border-t border-slate-800/80 hover:bg-slate-800/30">
                  <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums">{hour.hourUTC.slice(11, 16)}</td>
                  <td className="px-5 py-3 tabular-nums text-slate-300">{hour.measurements}/{hour.expectedHouseholds}</td>
                  <td className="px-5 py-3 tabular-nums">{hour.b12Matches}</td>
                  <td className={`px-5 py-3 font-medium ${result.className}`}>{result.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="border-t border-slate-800 px-5 py-3 text-xs text-slate-400">
        This overview shows recorded processing and trade data. It is not a live blockchain audit.
      </footer>
    </section>
  );
}
