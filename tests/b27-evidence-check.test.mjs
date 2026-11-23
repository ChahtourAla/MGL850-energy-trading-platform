import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessB27HederaEvidence,
  describeB27HederaEvidence,
} from '../apps/backend/src/b27-demo/b27-evidence-check.ts';

const buyer = `0x${'11'.repeat(20)}`;
const seller = `0x${'22'.repeat(20)}`;
const contract = `0x${'33'.repeat(20)}`;
const token = `0x${'44'.repeat(20)}`;

function fixture() {
  return {
    allocation: {
      buyerAddress: buyer,
      sellerAddress: seller,
      amountBaseUnits: 500000n,
    },
    intent: {
      chainId: 296,
      status: 'CONFIRMED',
      tokenAddress: token,
      contractAddress: contract,
      amountBaseUnits: 500000n,
    },
    evidence: {
      chainId: 296,
      receiptStatus: 'SUCCESS',
      verificationStatus: 'VERIFIED',
      txHash: `0x${'ab'.repeat(32)}`,
      contractAddress: contract,
      tokenAddress: token,
      buyerAddress: buyer,
      sellerAddress: seller,
      amountBaseUnits: 500000n,
      logIndex: 0,
      confirmedAt: new Date('2026-11-10T12:00:00Z'),
    },
  };
}

function assess(data) {
  return assessB27HederaEvidence(data.allocation, data.intent, data.evidence);
}

test('Consistent recorded evidence', () => {
  assert.equal(assess(fixture()), 'RECORDED_CONSISTENT');
});

test('Reject incorrect payment amount', () => {
  const data = fixture();
  data.evidence.amountBaseUnits = 600000n;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject incorrect seller', () => {
  const data = fixture();
  data.evidence.sellerAddress = buyer;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject incorrect buyer', () => {
  const data = fixture();
  data.evidence.buyerAddress = seller;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject incorrect token', () => {
  const data = fixture();
  data.evidence.tokenAddress = buyer;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject incorrect contract', () => {
  const data = fixture();
  data.evidence.contractAddress = seller;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject unsuccessful receipt', () => {
  const data = fixture();
  data.evidence.receiptStatus = 'FAILED';

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject unverified database evidence', () => {
  const data = fixture();
  data.evidence.verificationStatus = 'PENDING';

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject unexpected network', () => {
  const data = fixture();
  data.evidence.chainId = 31337;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject malformed transaction hash', () => {
  const data = fixture();
  data.evidence.txHash = 'invalid';

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject invalid log index', () => {
  const data = fixture();
  data.evidence.logIndex = -1;

  assert.equal(assess(data), 'MISMATCH');
});

test('Reject mismatched intent amount', () => {
  const data = fixture();
  data.intent.amountBaseUnits = 600000n;

  assert.equal(assess(data), 'MISMATCH');
});

test('Handle missing evidence', () => {
  const data = fixture();
  data.evidence = null;

  assert.equal(assess(data), 'NO_RECORD');
});

test('Handle missing contract binding', () => {
  const data = fixture();
  data.intent.contractAddress = null;

  assert.equal(assess(data), 'MISSING_CONTRACT_BINDING');
});

test('Handle missing Hedera intent', () => {
  const data = fixture();
  data.intent = null;

  assert.equal(assess(data), 'NOT_APPLICABLE');
});

test('Do not treat local chain as Hedera', () => {
  const data = fixture();
  data.intent.chainId = 31337;

  assert.equal(assess(data), 'NOT_APPLICABLE');
});

test('Accept case-insensitive EVM addresses', () => {
  const data = fixture();
  data.evidence.txHash = `0x${'AB'.repeat(32)}`;
  data.evidence.tokenAddress = data.evidence.tokenAddress.toUpperCase().replace(/^0X/, '0x');

  assert.equal(assess(data), 'RECORDED_CONSISTENT');
});

function describe(data) {
  return describeB27HederaEvidence(data.allocation, data.intent, data.evidence);
}

test('Consistent evidence is not independent proof', () => {
  const result = describe(fixture());

  assert.equal(result.evidenceConsistency, 'RECORDED_CONSISTENT');

  assert.equal(result.paymentStatus, 'RECORDED_EVIDENCE_ONLY');

  assert.equal(result.confirmedPaymentBaseUnits, '0');
  assert.equal(result.recordedConfirmedAt, '2026-11-10T12:00:00.000Z');
  assert.equal(result.transactionHash, `0x${'ab'.repeat(32)}`);
});

test('Wrong seller requires reconciliation', () => {
  const data = fixture();
  data.evidence.sellerAddress = buyer;

  const result = describe(data);

  assert.equal(result.paymentStatus, 'NEEDS_RECONCILIATION');

  assert.equal(result.transactionHash, null);
  assert.equal(result.confirmedPaymentBaseUnits, '0');
});

test('Missing evidence cannot confirm payment', () => {
  const data = fixture();
  data.evidence = null;

  const result = describe(data);

  assert.equal(result.paymentStatus, 'EVIDENCE_NOT_RECORDED');

  assert.equal(result.confirmedPaymentBaseUnits, '0');
});

test('Missing contract binding remains incomplete', () => {
  const data = fixture();
  data.intent.contractAddress = null;

  const result = describe(data);

  assert.equal(result.paymentStatus, 'EVIDENCE_INCOMPLETE');

  assert.equal(result.transactionHash, null);
});

test('Local chain is not labeled Hedera', () => {
  const data = fixture();
  data.intent.chainId = 31337;

  const result = describe(data);

  assert.equal(result.evidenceConsistency, 'NOT_APPLICABLE');

  assert.equal(result.paymentStatus, 'CONFIRMED');
  assert.equal(result.confirmedPaymentBaseUnits, '0');
});

test('Pending intent stays pending without evidence', () => {
  const data = fixture();
  data.intent.status = 'SUBMITTED';
  data.evidence = null;

  const result = describe(data);

  assert.equal(result.paymentStatus, 'SUBMITTED');
  assert.equal(result.confirmedPaymentBaseUnits, '0');
});
