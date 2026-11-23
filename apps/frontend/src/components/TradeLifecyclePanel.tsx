type Operation = {
  source: string;
  operation: string;
  status: string;
  chainId: number | null;
  transactionHash: string | null;
  recordedAt: string;
  confirmedAt: string | null;
};

type LifecycleItem = {
  matchId: string;
  intervalStart: string;
  side: 'BOUGHT' | 'SOLD';
  counterparty: string;
  quantityWh: string;
  quotedAmountMicrousd: string;
  matchingStatus: string;
  lifecycleStage: string;
  paymentVerification: string;
  trade: {
    tradeId: string;
    status: string;
    createdAt: string;
    onChainTradeId: string | null;
    latestDelivery: {
      status: string;
      deliveredWh: string;
    } | null;
  } | null;
  events: Operation[];
};

type LifecycleResponse = {
  items: LifecycleItem[];
  hasMore: boolean;
};

function decimal(value: string, places: number): string {
  const number = BigInt(value);
  const divisor = BigInt(10) ** BigInt(places);
  const negative = number < BigInt(0);
  const absolute = negative ? -number : number;

  return `${negative ? '-' : ''}${absolute / divisor}.${String(absolute % divisor).padStart(
    places,
    '0',
  )}`;
}

async function getLifecycle(userId: string, from: string, to: string): Promise<LifecycleResponse> {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;

  if (!base || !key) {
    throw new Error('Backend configuration missing');
  }

  const query = new URLSearchParams({ from, to });

  const response = await fetch(
    new URL(
      `/internal/v2/demo/users/${encodeURIComponent(userId)}` + `/lifecycle?${query.toString()}`,
      base,
    ),
    {
      headers: {
        'x-trading-read-key': key,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) {
    throw new Error(`Lifecycle API returned ${response.status}`);
  }

  return (await response.json()) as LifecycleResponse;
}

export default async function TradeLifecyclePanel({
  userId,
  from,
  to,
}: {
  userId: string;
  from: string;
  to: string;
}) {
  let history: LifecycleResponse;

  try {
    history = await getLifecycle(userId, from, to);
  } catch {
    return (
      <section className="rounded-xl border border-rose-900 bg-slate-900 p-5">
        <h3 className="text-xl font-semibold">Trade & Payment Lifecycle</h3>
        <p className="mt-3 text-sm text-rose-300">
          Lifecycle history unavailable. Check backend logs.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h3 className="text-xl font-semibold">Trade & Payment Lifecycle</h3>

      <p className="mt-2 text-sm text-slate-400">
        Follow each electricity match through trade creation, delivery and recorded payment
        operations.
      </p>

      <div className="mt-5 space-y-4">
        {history.items.length === 0 && (
          <p className="rounded-lg bg-slate-800 p-5 text-sm text-slate-300">
            No matches or trade lifecycle records for this period.
          </p>
        )}

        {history.items.map((item) => (
          <article
            key={item.matchId}
            className="rounded-xl border border-slate-700 bg-slate-800/50 p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">
                  {item.side === 'BOUGHT' ? 'Electricity Purchase' : 'Electricity Sale'}
                </p>

                <p className="mt-1 text-sm text-slate-400">
                  {item.counterparty} · {item.intervalStart.slice(0, 16).replace('T', ' ')} UTC
                </p>
              </div>

              <span className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold">
                {item.lifecycleStage.replaceAll('_', ' ')}
              </span>
            </div>

            <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-slate-400">Matched electricity</p>
                <p className="mt-1 font-semibold">{decimal(item.quantityWh, 3)} kWh</p>
              </div>

              <div>
                <p className="text-slate-400">Quoted value</p>
                <p className="mt-1 font-semibold">${decimal(item.quotedAmountMicrousd, 6)}</p>
              </div>

              <div>
                <p className="text-slate-400">Trade status</p>
                <p className="mt-1 font-semibold">{item.trade?.status ?? 'NOT CREATED'}</p>
              </div>

              <div>
                <p className="text-slate-400">Delivery status</p>
                <p className="mt-1 font-semibold">
                  {item.trade?.latestDelivery?.status ?? 'NOT RECORDED'}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-800/40 bg-amber-950/20 p-3">
              <p className="text-xs text-amber-200">
                Payment is not independently verified by this view. A matching result, trade status
                or recorded transaction hash is not proof of settlement.
              </p>
            </div>

            {item.events.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-cyan-300">
                  View recorded operations ({item.events.length})
                </summary>

                <div className="mt-3 space-y-3">
                  {item.events.map((event, index) => (
                    <div
                      key={`${event.source}-${event.operation}-${index}`}
                      className="rounded-lg bg-slate-900 p-4 text-sm"
                    >
                      <p className="font-medium">
                        {event.operation} — {event.status}
                      </p>

                      <p className="mt-1 text-xs text-slate-400">
                        {event.source} · {event.recordedAt.replace('T', ' ').slice(0, 19)} UTC
                      </p>

                      {event.confirmedAt && (
                        <p className="mt-1 text-xs text-slate-400">
                          Recorded confirmation: {event.confirmedAt.replace('T', ' ').slice(0, 19)}{' '}
                          UTC
                        </p>
                      )}

                      {event.chainId !== null && (
                        <p className="mt-1 text-xs text-slate-400">
                          Configured chain ID: {event.chainId}
                        </p>
                      )}

                      {event.transactionHash && (
                        <code className="mt-2 block break-all text-xs text-slate-300">
                          {event.transactionHash}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </article>
        ))}
      </div>

      {history.hasMore && (
        <p className="mt-4 text-sm text-amber-300">
          Showing the latest 50 matching records. Additional history is available.
        </p>
      )}
    </section>
  );
}
