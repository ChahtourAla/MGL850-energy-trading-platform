import { verifiedHederaTransactionLink } from './hederaExplorer';

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
      // Network errors must never turn an unverified payment into a paid one.
    }
  }

  if (!proof) {
    return <p className="mt-2 text-xs text-amber-300">Live Hedera verification unavailable.</p>;
  }

  if (proof.status !== 'VERIFIED_ON_CHAIN') {
    return (
      <p className="mt-2 text-xs text-amber-300">
        Hedera check: {proof.status.replaceAll('_', ' ')}.{' '}
        {proof.reason}
      </p>
    );
  }

  const rawAmount = proof.confirmedPaymentBaseUnits;
  const amount =
    rawAmount && /^\d+$/.test(rawAmount)
      ? `${BigInt(rawAmount) / BigInt(1000000)}.${String(BigInt(rawAmount) % BigInt(1000000)).padStart(6, '0')} TEUSD`
      : 'Unavailable';

  const explorer = verifiedHederaTransactionLink(proof);
  const verifiedHash =
    proof.transactionHash && /^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash)
      ? proof.transactionHash
      : null;

  return (
    <div className="mt-3 rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3 text-xs">
      <p className="font-semibold text-emerald-300">Hedera transfer verified on-chain</p>
      <p className="mt-1 text-slate-200">Verified amount: {amount}</p>
      <p className="mt-1 text-slate-400">Checked at: {proof.checkedAt ?? 'Unknown'}</p>

      {explorer ? (
        <div className="mt-3 space-y-2">
          <div>
            <p className="text-slate-400">Hedera transaction ID — open on HashScan</p>
            <a
              href={explorer.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block break-all font-medium text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
              aria-label={`Open Hedera transaction ${explorer.hederaTransactionId} on HashScan`}
            >
              {explorer.hederaTransactionId} ↗
            </a>
          </div>
          <div>
            <p className="text-slate-400">EVM transaction hash</p>
            <a
              href={explorer.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block break-all text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
              aria-label="Open the verified payment transaction hash on HashScan"
            >
              {explorer.evmTransactionHash}
            </a>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {verifiedHash && (
            <>
              <p className="text-slate-400">Verified EVM transaction hash</p>
              <code className="mt-1 block break-all text-slate-200">{verifiedHash}</code>
            </>
          )}
          <p className="mt-1 text-amber-300">
            Hedera transaction ID has not been resolved by the mirror node, so a direct HashScan link is unavailable.
          </p>
        </div>
      )}
    </div>
  );
}
