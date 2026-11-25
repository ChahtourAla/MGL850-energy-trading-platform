import B27LiveTeusdBalance from './B27LiveTeusdBalance';
import B27OnchainVerification from './B27OnchainVerification';

type TradingTotals = {
  confirmedTrades: number;
  boughtWh: string;
  soldWh: string;
  spentBaseUnits: string;
  earnedBaseUnits: string;
  netTradeFlowBaseUnits: string;
};

type WalletOverview = {
  wallet: { status: string; hederaAccountId: string | null; evmAddress: string | null };
  recordedTradingActivity: { hederaTestnet: TradingTotals };
};

type Trade = {
  allocationId: string;
  intervalStart: string;
  side: string;
  counterparty: { name: string };
  quantityWh: string;
  expectedPaymentBaseUnits: string;
  network: string;
};

type TradeHistory = { trades: Trade[]; pagination: { hasMore: boolean; nextOffset: number | null } };

function units(value: string, decimals: number): string {
  if (!/^-?\d+$/.test(value)) return 'Unavailable';
  const n = BigInt(value);
  const scale = BigInt(10) ** BigInt(decimals);
  const abs = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${abs / scale}.${String(abs % scale).padStart(decimals, '0')}`;
}

function energy(value: string): string { return `${units(value, 3)} kWh`; }
function teusd(value: string): string { return `${units(value, 6)} TEUSD`; }

async function backendGet<T>(path: string): Promise<T> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  if (!base || !key) throw new Error('Dashboard backend is not configured');
  const response = await fetch(new URL(path, base), {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

function TradingTotalsCard({ totals }: { totals: TradingTotals }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Your trading activity</h4>
        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">Hedera Testnet</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">Trades recorded for the selected dates</p>
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5">
        <div><p className="text-sm text-slate-400">Energy sold</p><p className="mt-1 font-semibold">{energy(totals.soldWh)}</p></div>
        <div><p className="text-sm text-slate-400">Energy bought</p><p className="mt-1 font-semibold">{energy(totals.boughtWh)}</p></div>
        <div><p className="text-sm text-slate-400">TEUSD earned</p><p className="mt-1 font-semibold text-emerald-300">{teusd(totals.earnedBaseUnits)}</p></div>
        <div><p className="text-sm text-slate-400">TEUSD spent</p><p className="mt-1 font-semibold text-amber-200">{teusd(totals.spentBaseUnits)}</p></div>
      </div>
      <p className="mt-5 border-t border-slate-800 pt-3 text-xs text-slate-400">
        {totals.confirmedTrades} recorded trade{totals.confirmedTrades === 1 ? '' : 's'} · Check individual payments below for live verification.
      </p>
    </div>
  );
}

export default async function TradingWalletPanels({ userId, from, to }: { userId: string; from: string; to: string }) {
  const path = `/internal/v2/demo/users/${encodeURIComponent(userId)}`;
  const query = new URLSearchParams({ from, to });
  const tradeQuery = new URLSearchParams({ from, to, limit: '50', offset: '0' });
  const [walletResult, historyResult] = await Promise.allSettled([
    backendGet<WalletOverview>(`${path}/wallet?${query}`),
    backendGet<TradeHistory>(`${path}/trades?${tradeQuery}`),
  ]);
  const wallet = walletResult.status === 'fulfilled' ? walletResult.value : null;
  const history = historyResult.status === 'fulfilled' ? historyResult.value : null;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-labelledby="wallet-title">
        <header className="mb-5">
          <h3 id="wallet-title" className="text-xl font-semibold">Your TEUSD wallet</h3>
          <p className="mt-1 text-sm text-slate-400">Your test-token balance and energy trading activity on Hedera Testnet.</p>
        </header>
        {wallet ? (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <B27LiveTeusdBalance userId={userId} />
              <TradingTotalsCard totals={wallet.recordedTradingActivity.hederaTestnet} />
            </div>
            <p className="mt-4 text-xs text-slate-400">
              Your balance includes your starting test tokens. Trading earnings and spending only describe the selected dates.
            </p>
            <details className="group mt-4 rounded-xl bg-slate-800/40 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">
                View wallet addresses
              </summary>
              <div className="mt-3 space-y-2 text-xs text-slate-300">
                <p className="break-all"><span className="text-slate-400">EVM address:</span> {wallet.wallet.evmAddress ?? 'Unavailable'}</p>
                <p className="break-all"><span className="text-slate-400">Hedera account:</span> {wallet.wallet.hederaAccountId ?? 'Unavailable'}</p>
              </div>
            </details>
          </>
        ) : (
          <p className="text-sm text-amber-200">Wallet details are temporarily unavailable. Try refreshing the page.</p>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900" aria-labelledby="trades-title">
        <header className="border-b border-slate-800 p-6">
          <h3 id="trades-title" className="text-xl font-semibold">Electricity trading history</h3>
          <p className="mt-1 text-sm text-slate-400">
            Energy bought and sold by this household. A green Paid label means the Hedera token transfer was independently verified.
          </p>
        </header>
        {!history ? (
          <p className="p-6 text-sm text-amber-200">Trading history is temporarily unavailable.</p>
        ) : history.trades.length === 0 ? (
          <div className="p-6">
            <p className="font-medium">No trades for this period</p>
            <p className="mt-2 text-sm text-slate-400">This household did not have any recorded electricity trades in the selected dates.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Electricity trades and independently verified Hedera payment status</caption>
              <thead className="bg-slate-800/80 text-slate-300">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">Date & time (UTC)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Action</th>
                  <th scope="col" className="px-4 py-3 font-medium">Other household</th>
                  <th scope="col" className="px-4 py-3 font-medium">Electricity</th>
                  <th scope="col" className="px-4 py-3 font-medium">Trade amount</th>
                  <th scope="col" className="px-4 py-3 font-medium">Payment</th>
                </tr>
              </thead>
              <tbody>
                {history.trades.map(trade => (
                  <tr key={trade.allocationId} className="border-t border-slate-800/80 align-top hover:bg-slate-800/30">
                    <td className="whitespace-nowrap px-4 py-4 tabular-nums">{trade.intervalStart.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-4">
                      <span className={`font-medium ${trade.side === 'BOUGHT' ? 'text-sky-300' : 'text-emerald-300'}`}>
                        {trade.side === 'BOUGHT' ? 'Bought' : 'Sold'}
                      </span>
                    </td>
                    <td className="px-4 py-4">{trade.counterparty.name}</td>
                    <td className="whitespace-nowrap px-4 py-4 tabular-nums">{energy(trade.quantityWh)}</td>
                    <td className="whitespace-nowrap px-4 py-4 tabular-nums">{teusd(trade.expectedPaymentBaseUnits)}</td>
                    <td className="px-4 py-4">
                      <B27OnchainVerification
                        userId={userId}
                        allocationId={trade.allocationId}
                        network={trade.network}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.pagination.hasMore && (
              <p className="border-t border-slate-800 p-4 text-xs text-slate-400">Showing the 50 most recent trades in this period.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
