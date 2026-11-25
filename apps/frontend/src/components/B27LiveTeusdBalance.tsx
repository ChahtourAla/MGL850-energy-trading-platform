/** Server component: the admin read key never leaves Next.js. */
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
  const n = BigInt(value);
  const whole = n / BigInt(1_000_000);
  const fraction = String(n % BigInt(1_000_000)).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
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
      if (response.ok) balance = (await response.json()) as BalancePayload;
    } catch {
      // Unavailable RPC reads must never appear as confirmed balances.
    }
  }

  const verified = balance?.token?.balanceStatus === 'VERIFIED_ON_CHAIN';
  const amount = verified ? displayTokenAmount(balance?.token.onChainBalanceBaseUnits ?? null) : null;

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold text-slate-100">Available TEUSD</h4>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${verified && amount !== null ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-200'}`}>
          {verified && amount !== null ? 'Live balance verified' : 'Balance unavailable'}
        </span>
      </div>
      {verified && amount !== null ? (
        <>
          <p className="mt-5 text-3xl font-bold tracking-tight text-white tabular-nums">{amount} <span className="text-xl font-medium text-slate-300">TEUSD</span></p>
          <p className="mt-2 text-xs text-slate-400">Checked on Hedera Testnet{balance?.token.blockNumber ? ` · Block ${balance.token.blockNumber}` : ''}</p>
        </>
      ) : (
        <p className="mt-5 text-sm text-amber-200">{balance?.token?.reason ?? 'Could not read the current Testnet balance.'}</p>
      )}
      <p className="mt-4 text-xs text-slate-400">This is your current test-token balance, not your earnings for the selected dates.</p>
    </section>
  );
}
