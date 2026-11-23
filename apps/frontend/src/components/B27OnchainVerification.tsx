type Proof = {
  readOnly: true;
  status: string;
  reason: string;
  confirmedPaymentBaseUnits: string | null;
  transactionHash: string | null;
  explorerUrl: string | null;
  checkedAt: string | null;
};

export default async function B27OnchainVerification({
  userId,
  allocationId,
  network,
}: {
  userId: string;
  allocationId: string;
  network: string;
}) {
  if (network !== 'HEDERA_TESTNET') {
    return null;
  }

  const base = process.env.B27_BACKEND_URL;
  const key = process.env.TRADING_API_READ_ADMIN_KEY;

  let proof: Proof | null = null;

  if (base && key) {
    try {
      const path =
        `/internal/v2/demo/users/${encodeURIComponent(userId)}` +
        `/trades/${encodeURIComponent(allocationId)}/verification`;

      const response = await fetch(new URL(path, base), {
        headers: {
          'x-trading-read-key': key,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });

      if (response.ok) {
        proof = (await response.json()) as Proof;
      }
    } catch {
      // Do not infer payment success during an outage.
    }
  }

  if (!proof) {
    return (
      <p className="mt-2 text-xs text-amber-300">
        Live Hedera verification unavailable.
      </p>
    );
  }

  if (proof.status !== 'VERIFIED_ON_CHAIN') {
    return (
      <p className="mt-2 text-xs text-amber-300">
        Hedera check: {proof.status.replaceAll('_', ' ')}.
        {' '}{proof.reason}
      </p>
    );
  }

  const rawAmount = proof.confirmedPaymentBaseUnits;

  const amount =
    rawAmount && /^\d+$/.test(rawAmount)
      ? `${BigInt(rawAmount) / BigInt(1000000)}.${String(
          BigInt(rawAmount) % BigInt(1000000),
        ).padStart(6, '0')} TEUSD`
      : 'Unavailable';

  const url = proof.explorerUrl;

  const safeUrl =
    url &&
    /^https:\/\/hashscan\.io\/testnet\/transaction\/[A-Za-z0-9@%._-]+$/.test(url)
      ? url
      : null;

  return (
    <div className="mt-3 rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3 text-xs">
      <p className="font-semibold text-emerald-300">
        Hedera transfer verified on-chain
      </p>

      <p className="mt-1 text-slate-200">
        Verified amount: {amount}
      </p>

      <p className="mt-1 text-slate-400">
        Checked at: {proof.checkedAt ?? 'Unknown'}
      </p>

      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-cyan-300 underline"
        >
          View verified transaction on HashScan
        </a>
      ) : (
        <p className="mt-2 text-slate-400">
          Explorer transaction ID not resolved.
        </p>
      )}
    </div>
  );
}
