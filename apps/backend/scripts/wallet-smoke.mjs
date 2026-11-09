// This script creates a REAL Hedera Testnet account and keeps its DB user.
// Run only after explicitly opting in: $env:B07_RUN_LIVE_TESTNET='YES'
// Run with the backend server already running and root .env configured.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

if (process.env.B07_RUN_LIVE_TESTNET !== 'YES') {
  throw new Error('Set B07_RUN_LIVE_TESTNET=YES to allow one real Testnet account creation.');
}
if (process.env.WALLET_PROVISIONING_ENABLED !== 'true') {
  throw new Error('WALLET_PROVISIONING_ENABLED=true is required in the root .env');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const baseUrl = process.env.B06_API_URL ?? 'http://localhost:3001';
const email = `b07-${randomUUID()}@example.invalid`;
const password = `Wallet-Test-Only-${randomUUID()}!`;

async function post(path, payload, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

try {
  const created = await post('/auth/register', {
    name: 'B07 TESTNET Wallet',
    email, password, physicalAddress: 'Simulated B07 Address',
    xKm: 1, yKm: 2, preferredEnergyType: 'SOLAR',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const userId = created.body.user.userId;
  const login = await post('/auth/login', { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.accessToken;
  const noAuth = await fetch(`${baseUrl}/users/me/wallet`);
  assert.equal(noAuth.status, 401);

  const result = await post('/users/me/wallet/provision', {}, token);
  if (result.status !== 200 || result.body.status !== 'READY') {
    console.error('B07: Provisioning uncertain; account may already exist on-chain.');
    console.error('Preserved recovery user email:', email);
    console.error('Reconcile using POST /users/me/wallet/reconcile, NEVER repeat account creation.');
    console.error('HTTP:', result.status, 'status:', result.body.status ?? 'unknown');
    process.exitCode = 1;
  } else {
    assert.match(result.body.hederaAccountId, /^\d+\.\d+\.\d+$/);
    assert.match(result.body.evmAddress, /^0x[0-9a-f]{40}$/);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    assert.ok(wallet.encryptedPrivateKey);
    assert.ok(wallet.encryptionIv);
    assert.ok(wallet.encryptionAuthTag);
    assert.equal(wallet.keyVersion, 1);
    assert.notEqual(wallet.encryptedPrivateKey, wallet.publicKey);
    assert.equal(wallet.hederaAccountId, result.body.hederaAccountId);
    assert.equal(wallet.evmAddress, result.body.evmAddress);
    assert.equal(await prisma.walletProvisioning.count({ where: { userId } }), 0);
    assert.ok(!JSON.stringify(result.body).includes('encryptedPrivateKey'));
    console.log('B07 PASS: real Testnet wallet created and encrypted key stored in PostgreSQL');
    console.log('B07 PASS: public identifiers match; staging record removed');
    console.log('B07 PASS: unauthenticated access blocked');
    console.log('Saved test account:', result.body.hederaAccountId);
    console.log('Saved recovery user email:', email);
  }
} finally {
  // Deliberately DON'T delete user/wallet: this is a real on-chain account.
  // Deleting DB records would orphan a funded on-chain identity.
  await prisma.$disconnect();
}
