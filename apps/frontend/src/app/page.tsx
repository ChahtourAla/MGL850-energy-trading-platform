import Link from 'next/link';
import { Suspense } from 'react';
import EnergyHistoryChart from '../components/EnergyHistoryChart';
import TradingWalletPanels from '../components/TradingWalletPanels';
import B34DayCoveragePanel from '../components/B34DayCoveragePanel';

type Household = { userId: string; name: string; energyType: string | null };
type EnergyHour = {
  intervalStart: string;
  productionWh: string;
  consumptionWh: string;
  netEnergyWh: string;
  role: string;
};
type EnergyOverview = {
  totals: {
    productionWh: string;
    consumptionWh: string;
    netEnergyWh: string;
    recordedHours: number;
  };
  hours: EnergyHour[];
};
type Query = { userId?: string; day?: string; from?: string; to?: string };

async function backendGet<T>(path: string): Promise<T> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  if (!base || !key) throw new Error('Dashboard backend connection is not configured.');
  const response = await fetch(new URL(path, base), {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Backend request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function kwh(value: string): string {
  const n = BigInt(value);
  const absolute = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${absolute / BigInt(1000)}.${String(absolute % BigInt(1000)).padStart(3, '0')} kWh`;
}

function energyPosition(role: string): string {
  if (role === 'SELLER') return 'Extra energy';
  if (role === 'BUYER') return 'Needs energy';
  if (role === 'NEUTRAL') return 'Balanced';
  return 'Unavailable';
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value?: string): value is string =>
  Boolean(value && datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

function nextUtcDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

async function Dashboard({ searchParams }: { searchParams: Promise<Query> }) {
  const params = await searchParams;
  const day = isDate(params.day) ? params.day : null;
  const from = day ?? (isDate(params.from) ? params.from : '2026-11-10');
  const to = day ? nextUtcDay(day) : isDate(params.to) ? params.to : '2026-11-11';
  const oneDay =
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) === 86400000 ? from : null;

  let users: Household[] = [];
  let overview: EnergyOverview | null = null;
  let error: string | null = null;

  try {
    users = (await backendGet<{ users: Household[] }>('/internal/v2/demo/users')).users;
  } catch {
    error = 'Could not load households. Check that the backend is running.';
  }

  const selectedUser = users.find((user) => user.userId === params.userId) ?? users[0];
  if (selectedUser && !error) {
    try {
      const query = new URLSearchParams({ from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` });
      overview = await backendGet<EnergyOverview>(
        `/internal/v2/demo/users/${encodeURIComponent(selectedUser.userId)}/energy?${query}`,
      );
    } catch {
      error = 'Energy readings are temporarily unavailable. Please try again.';
    }
  }
  const totals = overview?.totals;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-900/40 px-4 py-5 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-400">
              Energy Exchange
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">Peer-to-peer energy trading</h1>
            <p className="mt-1 text-sm text-slate-400">
              Follow household energy, electricity trades, and payments in one place.
            </p>
          </div>
          <span className="rounded-full border border-cyan-700/40 bg-cyan-950/40 px-3 py-1.5 text-xs font-medium text-cyan-200">
            Simulated households · Hedera Testnet
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside
          className="h-fit rounded-2xl border border-slate-800 bg-slate-900 p-4 lg:sticky lg:top-4"
          aria-label="Household selection"
        >
          <h2 className="font-semibold">Choose a household</h2>
          <p className="mt-1 text-xs text-slate-400">See the energy and trades for each home.</p>
          <nav className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {users.map((user) => {
              const selected = selectedUser?.userId === user.userId;
              return (
                <Link
                  key={user.userId}
                  href={`/?${new URLSearchParams({ userId: user.userId, from, to })}`}
                  aria-current={selected ? 'page' : undefined}
                  className={`rounded-xl px-3 py-3 text-sm transition focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                    selected
                      ? 'bg-cyan-700 font-semibold text-white'
                      : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {user.name}
                </Link>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0 space-y-6">
          <section className="space-y-4" aria-labelledby="selected-household-title">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Household overview
              </p>
              <h2 id="selected-household-title" className="mt-1 text-3xl font-bold tracking-tight">
                {selectedUser?.name ?? 'Energy dashboard'}
              </h2>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              {[
                ['Wallet', '#wallet-title'],
                ['My trades', '#trades-title'],
                ['Energy chart', '#energy-chart'],
                ...(oneDay ? [['Daily overview', '#daily-overview-title']] : []),
              ].map(([label, href]) => (
                <a
                  key={href}
                  href={href}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300 hover:border-cyan-600 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-cyan-300"
                >
                  {label}
                </a>
              ))}
            </div>
          </section>

          <section
            className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5"
            aria-label="Choose dates"
          >
            <form method="GET" action="/" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="userId" value={selectedUser?.userId ?? ''} />
              <label className="text-sm font-medium text-slate-200">
                Trading day (UTC)
                <input
                  className="mt-2 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 focus:outline-2 focus:outline-cyan-500"
                  type="date"
                  name="day"
                  defaultValue={oneDay ?? from}
                  required
                />
              </label>
              <button
                type="submit"
                className="rounded-lg bg-cyan-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-cyan-600 focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                View day
              </button>
              <span className="pb-2 text-xs text-slate-400">All times use UTC.</span>
            </form>
            <details className="mt-3 border-t border-slate-800 pt-3">
              <summary className="cursor-pointer text-xs text-cyan-300">
                Choose a longer date range
              </summary>
              <form method="GET" action="/" className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="userId" value={selectedUser?.userId ?? ''} />
                <label className="text-xs text-slate-300">
                  From
                  <input
                    type="date"
                    name="from"
                    defaultValue={from}
                    required
                    className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm text-white"
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Until (end date excluded)
                  <input
                    type="date"
                    name="to"
                    defaultValue={to}
                    required
                    className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm text-white"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600"
                >
                  Apply range
                </button>
              </form>
            </details>
          </section>

          {error && (
            <div
              role="alert"
              className="rounded-2xl border border-rose-800 bg-rose-950/30 p-5 text-sm text-rose-200"
            >
              {error}
            </div>
          )}
          {!error && users.length === 0 && (
            <div className="rounded-2xl bg-slate-900 p-5 text-sm text-slate-300">
              No simulated households found.
            </div>
          )}

          {totals && (
            <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Energy summary">
              {[
                ['Energy produced', kwh(totals.productionWh)],
                ['Energy used', kwh(totals.consumptionWh)],
                ['Energy difference', kwh(totals.netEnergyWh)],
                ['Hours recorded', String(totals.recordedHours)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5"
                >
                  <p className="text-xs text-slate-400">{label}</p>
                  <p className="mt-2 text-lg font-semibold tabular-nums sm:text-xl">{value}</p>
                </div>
              ))}
              <p className="col-span-full text-xs text-slate-400">
                Energy difference = produced minus used. A positive result means extra energy; a
                negative result means more energy was needed.
              </p>
            </section>
          )}

          {selectedUser && !error && (
            <TradingWalletPanels
              userId={selectedUser.userId}
              from={`${from}T00:00:00Z`}
              to={`${to}T00:00:00Z`}
            />
          )}

          {totals && overview && (
            <section
              id="energy-chart"
              className="space-y-4"
              aria-label="Energy production and consumption"
            >
              <EnergyHistoryChart hours={overview.hours} />
              <details className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                <summary className="cursor-pointer p-5 text-sm font-medium text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-300">
                  See hourly energy readings
                </summary>
                <div className="overflow-x-auto border-t border-slate-800">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-800/80 text-slate-300">
                      <tr>
                        {['Time (UTC)', 'Produced', 'Used', 'Difference', 'Energy position'].map(
                          (label) => (
                            <th
                              scope="col"
                              key={label}
                              className="whitespace-nowrap px-4 py-3 font-medium"
                            >
                              {label}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {overview.hours.map((hour) => (
                        <tr key={hour.intervalStart} className="border-t border-slate-800/80">
                          <td className="whitespace-nowrap px-4 py-3">
                            {hour.intervalStart.slice(0, 16).replace('T', ' ')}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">{kwh(hour.productionWh)}</td>
                          <td className="whitespace-nowrap px-4 py-3">{kwh(hour.consumptionWh)}</td>
                          <td className="whitespace-nowrap px-4 py-3">{kwh(hour.netEnergyWh)}</td>
                          <td className="px-4 py-3">{energyPosition(hour.role)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {overview.hours.length === 0 && (
                    <p className="p-5 text-sm text-slate-400">
                      No energy readings for these dates.
                    </p>
                  )}
                </div>
              </details>
            </section>
          )}

          {selectedUser && !error && oneDay && <B34DayCoveragePanel day={oneDay} />}

          {selectedUser && !error && (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
              <div>
                <h3 className="text-lg font-semibold">Want to explore further?</h3>
                <p className="mt-1 text-sm text-slate-400">
                  See suggested matches, community activity, and technical records on a separate
                  page.
                </p>
              </div>
              <Link
                href={`/details?${new URLSearchParams({ userId: selectedUser.userId, from, to })}`}
                className="rounded-lg border border-cyan-700 bg-cyan-950/40 px-4 py-2.5 text-sm font-medium text-cyan-200 hover:border-cyan-500 focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                More details <span aria-hidden="true">↗</span>
              </Link>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

export default function Home({ searchParams }: { searchParams: Promise<Query> }) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
          Loading the energy dashboard...
        </main>
      }
    >
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}
