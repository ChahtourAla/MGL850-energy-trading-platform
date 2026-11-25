import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifiedHederaTransactionLink } from '../apps/frontend/src/components/hederaExplorer.ts';
const hash = `0x${'a'.repeat(64)}`;
const url = 'https://hashscan.io/testnet/transaction/0.0.123456%401794000000.123456789';
const proof = (overrides = {}) => ({
  status: 'VERIFIED_ON_CHAIN', transactionHash: hash, explorerUrl: url, ...overrides,
});

test('shows a clickable canonical Hedera transaction ID for a verified payment', () => {
  assert.deepEqual(verifiedHederaTransactionLink(proof()), {
    url,
    hederaTransactionId: '0.0.123456@1794000000.123456789',
    evmTransactionHash: hash,
  });
});

test('allows the normalized Hedera hyphen transaction ID', () => {
  const normalized = 'https://hashscan.io/testnet/transaction/0.0.123456-1794000000-123456789';
  assert.equal(verifiedHederaTransactionLink(proof({explorerUrl: normalized}))?.hederaTransactionId,
    '0.0.123456-1794000000-123456789');
});

test('does not claim a pending payment has a verified explorer link', () => {
  for (const status of ['NO_INTENT', 'NOT_CONFIRMED', 'UNAVAILABLE', 'RECORD_MISMATCH', 'SUBMITTED']) {
    assert.equal(verifiedHederaTransactionLink(proof({status})), null);
  }
});

test('rejects unsafe explorer URLs and unsupported networks', () => {
  for (const candidate of [
    'https://hashscan.io/mainnet/transaction/0.0.123456%401794000000.123456789',
    'https://hashscan.io.evil.test/testnet/transaction/0.0.123456%401794000000.123456789',
    `${url}?redirect=https://evil.test`,
    `${url}#fragment`,
    'javascript:alert(1)',
    'https://hashscan.io/testnet/account/0.0.123456',
  ]) assert.equal(verifiedHederaTransactionLink(proof({ explorerUrl: candidate })), null);
});

test('rejects absent and malformed EVM transaction hashes and explorer URLs', () => {
  assert.equal(verifiedHederaTransactionLink(proof({ transactionHash: null })), null);
  assert.equal(verifiedHederaTransactionLink(proof({ transactionHash: '0x1234' })), null);
  assert.equal(verifiedHederaTransactionLink(proof({ explorerUrl: null })), null);
});
