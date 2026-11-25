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


test('allows official HashScan consensus-timestamp URL for verified EVM payment', () => {
  const url = 'https://hashscan.io/testnet/transaction/1795415309.464626984';
  const result = verifiedHederaTransactionLink(proof({ explorerUrl: url }));
  assert.equal(result?.url, url);
  assert.equal(result?.hederaTransactionId, '1795415309.464626984');
});

test('never links timestamps without proof, or malformed/unsafe timestamps', () => {
  const url = 'https://hashscan.io/testnet/transaction/1795415309.464626984';
  assert.equal(verifiedHederaTransactionLink(proof({ status: 'SUBMITTED', explorerUrl: url })), null);
  for (const suffix of [
    '1795415309.46462698',
    '1795415309.464626984?redirect=https://evil.test',
    '1795415309.464626984#fragment',
    '1795415309.464626984/other',
    '%2F1795415309.464626984',
    '1795415309.000000000.evil',
  ]) {
    assert.equal(verifiedHederaTransactionLink(proof({ explorerUrl: `https://hashscan.io/testnet/transaction/${suffix}` })), null);
  }
});
