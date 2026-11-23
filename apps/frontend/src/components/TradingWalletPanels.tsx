import B27LiveTeusdBalance from './B27LiveTeusdBalance';
import B27OnchainVerification from './B27OnchainVerification';
import B27PaymentEvidenceStatus from './B27PaymentEvidenceStatus';

type TradingTotals = {
  confirmedTrades: number;
  boughtWh: string;
  soldWh: string;
  spentBaseUnits: string;
  earnedBaseUnits: string;
  netTradeFlowBaseUnits: string;
};

type WalletOverview = {
  wallet: {
    status: string;
    hederaAccountId: string | null;
    evmAddress: string | null;
  };
  token: {
    symbol: string;
    decimals: number;
    onChainBalanceBaseUnits: string | null;
    balanceStatus: string;
  };
  confirmedTradingActivity: {
    localHardhat: TradingTotals;
    hederaTestnet: TradingTotals | null;
  };
  recordedTradingActivity: {
    hederaTestnet: TradingTotals;
  };
};

type Trade = {
  allocationId: string;
  intervalStart: string;
  side: string;

  counterparty: {
    name: string;
  };

  quantityWh: string;
  expectedPaymentBaseUnits: string;
  confirmedPaymentBaseUnits: string;

  paymentStatus: string;
  evidenceConsistency?: string | null;

  network: string;
  transactionHash: string | null;
  recordedConfirmedAt?: string | null;

  explorerUrl: string | null;
};

type TradeHistory = {
  trades: Trade[];
  pagination: {
    hasMore: boolean;
    nextOffset: number | null;
  };
};

function formatWh(value: string): string {
  const n = BigInt(value);
  const zero = BigInt(0);
  const unit = BigInt(1000);
  const negative = n < zero;
  const absolute = negative ? -n : n;

  return `${negative ? '-' : ''}${absolute / unit}.${String(absolute % unit).padStart(3, '0')} kWh`;
}

function formatTeusd(value: string): string {
  const n = BigInt(value);
  const zero = BigInt(0);
  const unit = BigInt(1000000);
  const negative = n < zero;
  const absolute = negative ? -n : n;

  return `${negative ? '-' : ''}${absolute / unit}.${String(absolute % unit).padStart(
    6,
    '0',
  )} TEUSD`;
}

async function backendGet<T>(path: string): Promise<T> {
  const baseUrl = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;

  if (!baseUrl || !key) {
    throw new Error('Missing dashboard server configuration');
  }

  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      'x-trading-read-key': key,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Backend returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function NetworkTotals({ title, totals, evidenceOnly = false }: { title: string; totals: TradingTotals; evidenceOnly?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
      <h4 className="mb-4 font-semibold">{title}</h4>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm text-slate-400">Energy sold</p>
          <p className="mt-1 font-semibold">{formatWh(totals.soldWh)}</p>
        </div>

        <div>
          <p className="text-sm text-slate-400">Energy bought</p>
          <p className="mt-1 font-semibold">{formatWh(totals.boughtWh)}</p>
        </div>

        <div>
          <p className="text-sm text-slate-400">{evidenceOnly ? 'Recorded TEUSD earnings' : 'TEUSD earned'}</p>
          <p className="mt-1 font-semibold text-emerald-400">
            {formatTeusd(totals.earnedBaseUnits)}
          </p>
        </div>

        <div>
          <p className="text-sm text-slate-400">{evidenceOnly ? 'Recorded TEUSD spending' : 'TEUSD spent'}</p>
          <p className="mt-1 font-semibold text-amber-300">{formatTeusd(totals.spentBaseUnits)}</p>
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        {totals.confirmedTrades}{' '}
        {evidenceOnly
          ? 'allocations with consistent database evidence. These payments are not independently verified by this wallet summary.'
          : 'canonical local Hardhat allocations.'}
      </p>
    </div>
  );
}

export default async function TradingWalletPanels({
  userId,
  from,
  to,
}: {
  userId: string;
  from: string;
  to: string;
}) {
  const userPath = `/internal/v2/demo/users/${encodeURIComponent(userId)}`;

  const walletQuery = new URLSearchParams({ from, to });

  const tradeQuery = new URLSearchParams({
    from,
    to,
    limit: '50',
    offset: '0',
  });

  const [walletResult, historyResult] = await Promise.allSettled([
    backendGet<WalletOverview>(`${userPath}/wallet?${walletQuery.toString()}`),

    backendGet<TradeHistory>(`${userPath}/trades?${tradeQuery.toString()}`),
  ]);

  const wallet = walletResult.status === 'fulfilled' ? walletResult.value : null;

  const history = historyResult.status === 'fulfilled' ? historyResult.value : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-5">
          <h3 className="text-xl font-semibold">TEUSD Wallet & Energy Trading</h3>

          <p className="mt-1 text-sm text-slate-400">
            Database-recorded trading activity for the selected date range. Independent payment
            verification is shown separately.
          </p>
        </div>

        {wallet ? (
          <>
            <div className="mb-5 rounded-lg border border-amber-800/50 bg-amber-950/20 p-4">
              <p className="text-sm text-amber-200">Wallet balance: Not verified on-chain</p>
              <p className="mt-1 text-xs text-slate-400">
                Trading earnings and spending are not the same as the current token balance.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <B27LiveTeusdBalance userId={userId} />
              <NetworkTotals
                title="Local Hardhat Simulation"
                totals={wallet.confirmedTradingActivity.localHardhat}
              />
              <NetworkTotals
                title="Hedera Testnet — Recorded Evidence"
                totals={wallet.recordedTradingActivity.hederaTestnet}
                evidenceOnly
              />
            </div>

            <div className="mt-5 rounded-lg bg-slate-800/50 p-4">
              <p className="text-sm">Wallet status: {wallet.wallet.status}</p>
              <p className="mt-2 break-all text-xs text-slate-400">
                EVM address: {wallet.wallet.evmAddress ?? 'Unavailable'}
              </p>
              <p className="mt-2 break-all text-xs text-slate-400">
                Hedera account: {wallet.wallet.hederaAccountId ?? 'Unavailable'}
              </p>
            </div>
          </>
        ) : (
          <p className="text-sm text-rose-300">
            Could not retrieve the wallet overview. Check the NestJS backend logs.
          </p>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 p-5">
          <h3 className="text-xl font-semibold">Electricity Trading History</h3>
          <p className="mt-1 text-sm text-slate-400">
            Latest 50 validated electricity allocations for the selected UTC date range. This is not
            token top-up history.
          </p>
        </div>

        {!history ? (
          <p className="p-5 text-sm text-rose-300">Could not retrieve trading history.</p>
        ) : history.trades.length === 0 ? (
          <div className="p-6">
            <p className="font-medium">No authoritative V2 trading allocations for this period</p>

            <p className="mt-2 text-sm text-slate-400">
              Electricity matches may exist in the Matching History section. This table displays
              only validated V2 allocations belonging to authoritative hourly market plans. No
              blockchain payment is assumed.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-800 text-slate-300">
                <tr>
                  <th className="p-4">UTC Time</th>
                  <th className="p-4">Activity</th>
                  <th className="p-4">Counterparty</th>
                  <th className="p-4">Electricity</th>
                  <th className="p-4">Expected payment</th>
                  <th className="p-4">Confirmed payment</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">Blockchain</th>
                </tr>
              </thead>

              <tbody>
                {history.trades.map((trade) => {
                  return (
                    <tr key={trade.allocationId} className="border-t border-slate-800 align-top">
                      <td className="whitespace-nowrap p-4">
                        {trade.intervalStart.replace('T', ' ').slice(0, 16)}
                      </td>

                      <td className="p-4 font-medium">
                        {trade.side === 'BOUGHT' ? 'Bought' : 'Sold'}
                      </td>

                      <td className="p-4">{trade.counterparty.name}</td>

                      <td className="p-4">{formatWh(trade.quantityWh)}</td>

                      <td className="p-4">{formatTeusd(trade.expectedPaymentBaseUnits)}</td>

                      <td className="p-4">
                        {trade.network === 'HEDERA_TESTNET' ? (
                          <span className="text-xs text-amber-300">See live verification</span>
                        ) : (
                          formatTeusd(trade.confirmedPaymentBaseUnits)
                        )}
                      </td>

                      <td className="min-w-72 p-4">
                        <B27PaymentEvidenceStatus trade={trade} />
                          <B27OnchainVerification
                            userId={userId}
                            allocationId={trade.allocationId}
                            network={trade.network}
                          />
                      </td>

                      <td className="p-4 text-xs text-slate-400">{trade.network}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {history.pagination.hasMore && (
              <p className="p-4 text-xs text-slate-400">
                More historical trades are available. Pagination will be added next.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
