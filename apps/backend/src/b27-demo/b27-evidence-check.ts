type Allocation = {
  buyerAddress: string;
  sellerAddress: string;
  amountBaseUnits: bigint;
};

type Intent = {
  chainId: number;
  status: string;
  tokenAddress: string;
  contractAddress: string | null;
  amountBaseUnits: bigint;
};

type Evidence = {
  chainId: number;
  receiptStatus: string;
  verificationStatus: string;
  txHash: string;
  contractAddress: string;
  tokenAddress: string;
  buyerAddress: string;
  sellerAddress: string;
  amountBaseUnits: bigint;
  logIndex: number;
  confirmedAt: Date;
};

export type B27EvidenceStatus =
  'NOT_APPLICABLE' | 'NO_RECORD' | 'MISSING_CONTRACT_BINDING' | 'MISMATCH' | 'RECORDED_CONSISTENT';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

function sameAddress(a: string, b: string): boolean {
  return ADDRESS.test(a) && ADDRESS.test(b) && a.toLowerCase() === b.toLowerCase();
}

export function assessB27HederaEvidence(
  allocation: Allocation,
  intent: Intent | null,
  evidence: Evidence | null,
): B27EvidenceStatus {
  if (!intent || intent.chainId !== 296) {
    return 'NOT_APPLICABLE';
  }

  if (!evidence) {
    return 'NO_RECORD';
  }

  // Without an expected contract address,
  // this checker cannot prove contract identity.
  if (!intent.contractAddress) {
    return 'MISSING_CONTRACT_BINDING';
  }

  const valid =
    intent.status === 'CONFIRMED' &&
    evidence.chainId === 296 &&
    evidence.receiptStatus === 'SUCCESS' &&
    evidence.verificationStatus === 'VERIFIED' &&
    intent.amountBaseUnits > 0n &&
    allocation.amountBaseUnits === intent.amountBaseUnits &&
    evidence.amountBaseUnits === intent.amountBaseUnits &&
    sameAddress(allocation.buyerAddress, evidence.buyerAddress) &&
    sameAddress(allocation.sellerAddress, evidence.sellerAddress) &&
    sameAddress(intent.tokenAddress, evidence.tokenAddress) &&
    sameAddress(intent.contractAddress, evidence.contractAddress) &&
    TX_HASH.test(evidence.txHash) &&
    Number.isInteger(evidence.logIndex) &&
    evidence.logIndex >= 0 &&
    evidence.confirmedAt instanceof Date &&
    Number.isFinite(evidence.confirmedAt.getTime());

  return valid ? 'RECORDED_CONSISTENT' : 'MISMATCH';
}

export type B27HederaPresentation = {
  evidenceConsistency: B27EvidenceStatus;
  paymentStatus: string;
  confirmedPaymentBaseUnits: string;
  transactionHash: string | null;
  recordedConfirmedAt: string | null;
};

export function describeB27HederaEvidence(
  allocation: Allocation,
  intent: Intent | null,
  evidence: Evidence | null,
): B27HederaPresentation {
  const consistency = assessB27HederaEvidence(allocation, intent, evidence);

  // This presenter does not independently contact Hedera.
  // Never claim a verified payment based only on DB rows.
  const base = {
    evidenceConsistency: consistency,
    confirmedPaymentBaseUnits: '0',
    transactionHash: null,
    recordedConfirmedAt: null,
  };

  switch (consistency) {
    case 'NOT_APPLICABLE':
      return {
        ...base,
        paymentStatus: intent?.status ?? 'NOT_SUBMITTED',
      };

    case 'NO_RECORD':
      return {
        ...base,
        paymentStatus:
          intent?.status === 'CONFIRMED'
            ? 'EVIDENCE_NOT_RECORDED'
            : (intent?.status ?? 'NOT_SUBMITTED'),
      };

    case 'MISSING_CONTRACT_BINDING':
      return {
        ...base,
        paymentStatus: 'EVIDENCE_INCOMPLETE',
      };

    case 'MISMATCH':
      return {
        ...base,
        paymentStatus: 'NEEDS_RECONCILIATION',
      };

    case 'RECORDED_CONSISTENT':
      return {
        ...base,
        paymentStatus: 'RECORDED_EVIDENCE_ONLY',
        transactionHash: evidence!.txHash,
        recordedConfirmedAt: evidence!.confirmedAt.toISOString(),
      };
  }
}
