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

type Props = {
  userId: string;
  allocationId: string;
  network: string;
};

/** Only the read-only RPC proof endpoint is allowed to authorize a green "Paid" label. */
export default async function B27OnchainVerification({ userId, allocationId, network }: Props) {
  if (network !== 'HEDERA_TESTNET') {
    return <span className="text-xs text-slate-400">No Testnet payment</span>;
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
        headers: { 'x-trading-read-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      if (response.ok) proof = (await response.json()) as Proof;
    } catch {
      // A failed live read must never be presented as a successful transfer.
    }
  }

  if (!proof || proof.status === 'UNAVAILABLE') {
    return (
      <span className="inline-flex rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200" title="The live payment check could not be completed. Try again later.">
        Verification unavailable
      </span>
    );
  }

  if (proof.status !== 'VERIFIED_ON_CHAIN') {
    const noPayment = ['NO_INTENT', 'NOT_CONFIRMED', 'NO_EVIDENCE'].includes(proof.status);
    return (
      <span
        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${noPayment ? 'bg-slate-700 text-slate-300' : 'bg-amber-400/10 text-amber-200'}`}
        title={proof.reason || 'A blockchain payment could not be confirmed.'}
      >
        {noPayment ? 'Not confirmed' : 'Needs review'}
      </span>
    );
  }

  const explorer = verifiedHederaTransactionLink(proof);
  const amount = proof.confirmedPaymentBaseUnits && /^\d+$/.test(proof.confirmedPaymentBaseUnits)
    ? `${BigInt(proof.confirmedPaymentBaseUnits) / BigInt(1_000_000)}.${String(BigInt(proof.confirmedPaymentBaseUnits) % BigInt(1_000_000)).padStart(6, '0')} TEUSD`
    : null;

  return (
    <div className="flex min-w-[135px] flex-col items-start gap-2">
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300"
        title="Payment confirmed by checking the Hedera Testnet transaction and token transfer."
      >
        <span aria-hidden="true">✓</span> Paid
      </span>
      {explorer ? (
        <a
          href={explorer.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-cyan-300 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-200 focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          aria-label="View verified Hedera Testnet payment on HashScan (opens in a new tab)"
          title={`Verified transfer${amount ? `: ${amount}` : ''}. Open on HashScan.`}
        >
          View transaction <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <span className="text-xs text-slate-400" title="The transfer is verified, but the explorer transaction ID was not resolved.">
          Explorer link unavailable
        </span>
      )}
    </div>
  );
}
