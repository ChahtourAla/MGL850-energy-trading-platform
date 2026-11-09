import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const baseUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';
const apiKey = process.env.INTERNAL_IMPORT_API_KEY;
const url = process.env.DATABASE_URL;
if (!apiKey || apiKey.length < 32 || !url) {
  throw new Error('INTERNAL_IMPORT_API_KEY (32+ chars) and DATABASE_URL are required');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const ids = [randomUUID(), randomUUID()];
const registry = {
  schemaVersion: '1.0.0',
  users: ids.map((userId, index) => ({
    userId,
    name: `B08 Synthetic House ${index + 1}`,
    email: `b08-${userId}@example.invalid`,
    physicalAddress: `B08 Simulated Street ${index + 1}`,
    xKm: 1 + index,
    yKm: 2 + index,
    preferredEnergyType: index === 0 ? 'SOLAR' : 'ANY',
    reputation: 75,
  })),
};

async function post(payload, key = apiKey) {
  const response = await fetch(`${baseUrl}/internal/users/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-key': key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  return { status: response.status, body: await response.json() };
}

try {
  const denied = await fetch(`${baseUrl}/internal/users/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registry),
  });
  assert.equal(denied.status, 403);
  console.log('B08 PASS: import endpoint rejects missing internal credential');

  const first = await post(registry);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.created, 2);

  const saved = await prisma.user.findMany({ where: { id: { in: ids } } });
  assert.equal(saved.length, 2);
  for (const row of saved) {
    assert.equal(row.accountOrigin, 'SIMULATED');
    assert.equal(row.passwordHash, '!SIMULATED_ACCOUNT_NO_LOGIN!');
    assert.equal(await prisma.wallet.count({ where: { userId: row.id } }), 0);
  }
  console.log('B08 PASS: registry stored in PostgreSQL with disabled credentials');

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registry.users[0].email, password: 'NotARealPassword123!' }),
  });
  assert.equal(login.status, 401);
  console.log('B08 PASS: simulated account cannot authenticate');

  const second = await post(registry);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.unchanged, 2);
  console.log('B08 PASS: second import does not create duplicates');

  const changed = structuredClone(registry);
  changed.users[0].name = 'B08 Updated Synthetic House';
  const third = await post(changed);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(third.body.updated, 1);
  console.log('B08 PASS: simulated profile update permitted');

  const conflict = structuredClone(registry);
  conflict.users[0].userId = randomUUID();
  const deniedConflict = await post(conflict);
  assert.equal(deniedConflict.status, 409, JSON.stringify(deniedConflict.body));
  assert.equal(await prisma.user.count({ where: { id: { in: ids } } }), 2);
  console.log('B08 PASS: identity collision rejected without partial writes');
} finally {
  // Cleanup is restricted to the exact synthetic IDs created by this test.
  try {
    await prisma.user.deleteMany({
      where: { id: { in: ids }, accountOrigin: 'SIMULATED', passwordHash: '!SIMULATED_ACCOUNT_NO_LOGIN!' },
    });
    console.log('B08 PASS: synthetic records cleaned up');
  } finally {
    await prisma.$disconnect();
  }
}
