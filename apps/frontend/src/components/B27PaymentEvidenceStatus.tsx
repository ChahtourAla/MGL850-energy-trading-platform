type PaymentRecord = {
  paymentStatus?: string | null;
  evidenceConsistency?: string | null;
  network?: string | null;
  transactionHash?: string | null;
  recordedConfirmedAt?: string | null;
};

type Props = {
  trade: PaymentRecord;
};

function describePayment(trade: PaymentRecord) {
  switch (trade.paymentStatus) {
    case 'RECORDED_EVIDENCE_ONLY':
      return {
        label: 'Payment evidence recorded',
        message:
          'The stored evidence matches the allocation, ' +
          'but the blockchain payment has not been ' +
          'independently verified by this dashboard.',
      };

    case 'NEEDS_RECONCILIATION':
      return {
        label: 'Payment requires reconciliation',
        message:
          'The stored payment information is inconsistent ' + 'or contains conflicting evidence.',
      };

    case 'EVIDENCE_NOT_RECORDED':
      return {
        label: 'Payment evidence missing',
        message:
          'A settlement is recorded, but sufficient ' + 'confirmation evidence is unavailable.',
      };

    case 'EVIDENCE_INCOMPLETE':
      return {
        label: 'Payment evidence incomplete',
        message:
          'The current verification rules cannot establish ' + 'the payment contract identity.',
      };

    case 'CONFIRMED_LOCAL':
      return {
        label: 'Confirmed on local test chain',
        message: 'This is a local Hardhat test result, ' + 'not a Hedera Testnet payment.',
      };

    case 'CONFIRMED_HEDERA':
      return {
        label: 'Hedera confirmation claim',
        message:
          'This stored confirmation still requires ' + 'independent settlement verification.',
      };

    case 'SUBMITTED':
      return {
        label: 'Payment submitted',
        message:
          'A payment attempt has been recorded. ' + 'Successful settlement is not established.',
      };

    case 'NOT_SUBMITTED':
    case 'PLANNED':
      return {
        label: 'Payment not submitted',
        message: 'No confirmed settlement has been recorded.',
      };

    default:
      return {
        label: 'Payment status unavailable',
        message: 'The available records are insufficient ' + 'to confirm settlement.',
      };
  }
}

export default function B27PaymentEvidenceStatus({ trade }: Props) {
  const details = describePayment(trade);

  const validHash = trade.transactionHash && /^0x[a-fA-F0-9]{64}$/.test(trade.transactionHash);

  return (
    <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/70 p-4">
      <p className="text-sm font-semibold text-slate-100">{details.label}</p>

      <p className="mt-2 text-sm text-slate-400">{details.message}</p>

      <p className="mt-3 text-xs text-slate-500">Network: {trade.network ?? 'Not assigned'}</p>

      {trade.evidenceConsistency && trade.evidenceConsistency !== 'NOT_APPLICABLE' && (
        <p className="mt-1 text-xs text-slate-400">
          Database evidence: {trade.evidenceConsistency.replaceAll('_', ' ')}
        </p>
      )}

      {validHash && (
        <div className="mt-3">
          <p className="text-xs text-slate-400">Recorded transaction hash (not proof of payment)</p>
          <code className="mt-1 block break-all text-xs text-slate-300">
            {trade.transactionHash}
          </code>
        </div>
      )}

      {trade.recordedConfirmedAt && (
        <p className="mt-2 text-xs text-slate-400">
          Recorded confirmation time: {trade.recordedConfirmedAt}
        </p>
      )}

      <p className="mt-3 text-xs text-amber-300">
        Independent Hedera settlement verification is not provided by this view.
      </p>
    </div>
  );
}
