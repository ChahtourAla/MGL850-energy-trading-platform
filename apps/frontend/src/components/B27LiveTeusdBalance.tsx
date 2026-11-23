/** Server component: keeps TRADING_API_READ_ADMIN_KEY on the server only. */
type BalancePayload = {
  token: {
    symbol: string;
    decimals: number;
    balanceStatus: string;
    onChainBalanceBaseUnits: string | null;
    blockNumber: string | null;
    checkedAt: string | null;
    reason: string;
  };
};

function displayTokenAmount(value: string | null): string | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const digits = value.padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export default async function B27LiveTeusdBalance({ userId }: { userId: string }) {
  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  let balance: BalancePayload | null = null;

  if (base && key && /^[0-9a-fA-F-]{36}$/.test(userId)) {
    try {
      const path = `/internal/v2/demo/users/${encodeURIComponent(userId)}/token-balance`;
      const response = await fetch(new URL(path, base), {
        headers: { 'x-trading-read-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      if (response.ok) balance = await response.json() as BalancePayload;
    } catch {
      // Fail closed: do not display a fabricated balance.
    }
  }

  const confirmed = balance?.token?.balanceStatus === 'VERIFIED_ON_CHAIN';
  const amount = confirmed
    ? displayTokenAmount(balance?.token.onChainBalanceBaseUnits ?? null)
    : null;

  return (
    <section className="my-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Live TEUSD wallet balance
        </h3>
        <span className={confirmed && amount !== null
          ? 'text-xs text-emerald-300'
          : 'text-xs text-amber-300'}>
          {confirmed && amount !== null ? 'Hedera Testnet · Verified read' : 'Not verified'}
        </span>
      </div>
      {confirmed && amount !== null ? (
        <>
          <p className="mt-2 text-2xl font-bold text-white">{amount} TEUSD</p>
          <p className="mt-1 text-xs text-slate-400">
            Read at block {balance?.token.blockNumber ?? 'unknown'} · Checked {balance?.token.checkedAt ?? 'unknown'}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-amber-200">
          {balance?.token?.reason ?? 'Live balance unavailable. Check backend URL and read key.'}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        Token balance is separate from recorded trading activity and does not prove payment settlement.
      </p>
    </section>
  );
}
