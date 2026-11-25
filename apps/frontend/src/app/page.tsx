import Link from 'next/link';
import { Suspense } from 'react';
import EnergyHistoryChart from '../components/EnergyHistoryChart';
import TradingWalletPanels from '../components/TradingWalletPanels';
import MatchingHistoryPanel from '../components/MatchingHistoryPanel';
import TradeLifecyclePanel from '../components/TradeLifecyclePanel';
import B30AllHouseholds from '../components/B30AllHouseholds';

type Household = {
  userId: string;
  name: string;
  energyType: string | null;
};

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

async function backendGet<T>(path: string): Promise<T> {
  const baseUrl = process.env.B27_BACKEND_URL;
  const readKey = process.env.TRADING_API_READ_ADMIN_KEY;

  if (!baseUrl || !readKey) {
    throw new Error('Frontend backend configuration is missing.');
  }

  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      'x-trading-read-key': readKey,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function formatKwh(wh: string): string {
  const value = BigInt(wh);
  const zero = BigInt(0);
  const thousand = BigInt(1000);

  const sign = value < zero ? '-' : '';
  const absolute = value < zero ? -value : value;

  const kwh = absolute / thousand;
  const remainder = absolute % thousand;

  return `${sign}${kwh}.${String(remainder).padStart(3, '0')} kWh`;
}

async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{
    userId?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const params = await searchParams;

  // Default to the historical B26 demonstration window.
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  const from = datePattern.test(params.from ?? '') ? params.from! : '2026-11-09';

  const to = datePattern.test(params.to ?? '') ? params.to! : '2026-11-11';

  let users: Household[] = [];
  let overview: EnergyOverview | null = null;
  let error: string | null = null;

  try {
    const result = await backendGet<{ users: Household[] }>('/internal/v2/demo/users');
    users = result.users;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Backend unavailable.';
  }

  const selectedUser = users.find((user) => user.userId === params.userId) ?? users[0];

  if (selectedUser && !error) {
    try {
      const query = new URLSearchParams({
        from: `${from}T00:00:00Z`,
        to: `${to}T00:00:00Z`,
      });

      overview = await backendGet<EnergyOverview>(
        `/internal/v2/demo/users/${encodeURIComponent(selectedUser.userId)}/energy?${query}`,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Energy history unavailable.';
    }
  }

  const totals = overview?.totals;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-5">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Energy Trading Platform</h1>
            <p className="mt-1 text-sm text-slate-400">MGL850 · Peer-to-Peer Energy Trading</p>
          </div>
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-sm text-amber-300">
            Simulated households · Hedera Testnet
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-[260px_1fr]">
        <aside className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-4 font-semibold">Households</h2>
          <p className="mb-3 text-xs text-slate-400">
            Select a household to explore its energy history.
          </p>

          <div className="space-y-2">
            {users.map((user) => {
              const active = selectedUser?.userId === user.userId;

              return (
                <Link
                  key={user.userId}
                  href={`/?${new URLSearchParams({
                    userId: user.userId,
                    from,
                    to,
                  })}`}
                  className={`block rounded-lg px-4 py-3 transition ${
                    active
                      ? 'bg-cyan-700 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <div className="text-sm font-medium">{user.name}</div>
                  <div className="mt-1 text-xs opacity-70">
                    {user.energyType ?? 'Energy household'}
                  </div>
                </Link>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 space-y-6">
          <div>
            <h2 className="text-3xl font-bold">{selectedUser?.name ?? 'Energy Overview'}</h2>
            <p className="mt-2 text-sm text-slate-400">Historical production and consumption</p>
          </div>

          <form
            className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4"
            action="/"
            method="GET"
          >
            <input type="hidden" name="userId" value={selectedUser?.userId ?? ''} />
            <label className="text-sm">
              From
              <input
                className="mt-1 block rounded bg-slate-800 p-2"
                type="date"
                name="from"
                defaultValue={from}
              />
            </label>
            <label className="text-sm">
              To (exclusive)
              <input
                className="mt-1 block rounded bg-slate-800 p-2"
                type="date"
                name="to"
                defaultValue={to}
              />
            </label>
            <button className="rounded bg-cyan-700 px-5 py-2 font-medium hover:bg-cyan-600">
              Apply
            </button>
          </form>

          {error && (
            <div className="rounded-xl border border-red-800 bg-red-950/30 p-4 text-red-200">
              {error}
            </div>
          )}

          {!error && users.length === 0 && (
            <div className="rounded-xl bg-slate-900 p-5 text-slate-300">
              No simulated households were found in the connected database.
            </div>
          )}

          {totals && (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {[
                  ['Production', formatKwh(totals.productionWh)],
                  ['Consumption', formatKwh(totals.consumptionWh)],
                  ['Net Energy', formatKwh(totals.netEnergyWh)],
                  ['Recorded Hours', String(totals.recordedHours)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                    <p className="text-sm text-slate-400">{label}</p>
                    <p className="mt-3 text-2xl font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              <EnergyHistoryChart hours={overview!.hours} />
              <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                <div className="border-b border-slate-800 p-5">
                  <h3 className="font-semibold">Hourly Energy History</h3>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-800 text-slate-300">
                      <tr>
                        {['UTC Hour', 'Production', 'Consumption', 'Net Energy', 'Role'].map(
                          (heading) => (
                            <th key={heading} className="p-4">
                              {heading}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {overview!.hours.map((hour) => (
                        <tr key={hour.intervalStart} className="border-t border-slate-800">
                          <td className="p-4">
                            {hour.intervalStart.replace('T', ' ').slice(0, 16)}
                          </td>
                          <td className="p-4">{formatKwh(hour.productionWh)}</td>
                          <td className="p-4">{formatKwh(hour.consumptionWh)}</td>
                          <td className="p-4">{formatKwh(hour.netEnergyWh)}</td>
                          <td className="p-4">{hour.role}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {overview!.hours.length === 0 && (
                    <p className="p-6 text-sm text-slate-400">
                      No finalized energy measurements for this period.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
          {selectedUser && !error && (
            <TradingWalletPanels
              userId={selectedUser.userId}
              from={`${from}T00:00:00Z`}
              to={`${to}T00:00:00Z`}
            />
          )}
          {selectedUser && !error && (
            <MatchingHistoryPanel
              userId={selectedUser.userId}
              from={`${from}T00:00:00Z`}
              to={`${to}T00:00:00Z`}
            />
          )}
          {selectedUser && !error && (
            <B30AllHouseholds
              from={`${from}T00:00:00Z`}
              to={`${to}T00:00:00Z`}
            />
          )}
          {selectedUser && !error && (
            <TradeLifecyclePanel
              userId={selectedUser.userId}
              from={`${from}T00:00:00Z`}
              to={`${to}T00:00:00Z`}
            />
          )}
        </section>
      </div>
    </main>
  );
}

export default function Home({
  searchParams,
}: {
  searchParams: Promise<{
    userId?: string;
    from?: string;
    to?: string;
  }>;
}) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
          Loading energy dashboard...
        </main>
      }
    >
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}
