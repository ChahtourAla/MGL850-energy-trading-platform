// B09 smoke test: uses an EXISTING B07 wallet, never creates a blockchain account.
// Starts from a real DB user, imports a synthetic hourly record, verifies it,
// and deletes ONLY records created by this script.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const baseUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';
const key = process.env.INTERNAL_IMPORT_API_KEY;
if (!process.env.DATABASE_URL || !key || key.length < 32) {
  throw new Error('DATABASE_URL and 32+ character INTERNAL_IMPORT_API_KEY are required');
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const snapshotId = randomUUID();
const recordId = randomUUID();

async function send(body, withAuth = true) {
  const res = await fetch(`${baseUrl}/internal/energy/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { 'x-internal-api-key': key } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  return { status: res.status, body: await res.json() };
}

try {
  const wallet = await prisma.wallet.findFirst({
    select: { userId: true, evmAddress: true },
  });
  if (!wallet) {
    throw new Error('No B07 wallet found in PostgreSQL. The smoke test will not invent an address. Run B07 live smoke first.');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: wallet.userId } });

  // Use a reserved synthetic future hour. Never overwrite an existing hour.
  let timeSlot;
  for (let offset = 0; offset < 48; offset++) {
    const candidate = new Date(Date.UTC(2032, 0, 1 + offset, 0, 0, 0));
    const [batch, count] = await Promise.all([
      prisma.energySnapshotImport.findUnique({ where: { timeSlot: candidate } }),
      prisma.energyRecord.count({ where: { timeSlot: candidate } }),
    ]);
    if (!batch && count === 0) {
      timeSlot = candidate.toISOString().replace('.000Z', 'Z');
      break;
    }
  }
  if (!timeSlot) throw new Error('No free synthetic UTC hour found for smoke test');

  const snapshot = {
    schemaVersion: '1.0.0',
    snapshotId,
    timeSlot,
    generatorVersion: '1.0.0',
    users: [{
      recordId, userId: wallet.userId, timeSlot,
      productionWh: 3000, consumptionWh: 1000, netEnergyWh: 2000,
      marketRole: 'SELLER', availableEnergyWh: 2000, requiredEnergyWh: 0,
      energyType: 'SOLAR', askPriceMicrousdPerKwh: 140000,
      maxPriceMicrousdPerKwh: null,
      xKm: user.xKm?.toNumber() ?? 0,
      yKm: user.yKm?.toNumber() ?? 0,
      reputation: user.reputation,
      preferredEnergyType: user.preferredEnergyType ?? 'ANY',
      evmAddress: wallet.evmAddress,
    }],
  };

  assert.equal((await send(snapshot, false)).status, 403);
  console.log('B09 PASS: internal import requires a service credential');

  const first = await send(snapshot);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.created, 1);
  const [batch, stored] = await Promise.all([
    prisma.energySnapshotImport.findUniqueOrThrow({ where: { id: snapshotId } }),
    prisma.energyRecord.findUniqueOrThrow({ where: { id: recordId } }),
  ]);
  assert.equal(batch.recordCount, 1);
  assert.equal(stored.snapshotId, snapshotId);
  assert.equal(stored.userId, wallet.userId);
  assert.equal(stored.netEnergyWh, 2000n);
  assert.equal(stored.askPriceMicrousdPerKwh, 140000n);
  console.log('B09 PASS: real PostgreSQL stores the snapshot and exact bigint Wh/prices');

  const second = await send(snapshot);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.created, 0);
  assert.equal(second.body.unchanged, 1);
  console.log('B09 PASS: identical snapshot is idempotent');

  const changed = structuredClone(snapshot);
  changed.users[0].productionWh += 1;
  changed.users[0].netEnergyWh += 1;
  changed.users[0].availableEnergyWh += 1;
  const conflict = await send(changed);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(await prisma.energyRecord.count({ where: { snapshotId } }), 1);
  console.log('B09 PASS: conflicting snapshot cannot overwrite an accepted UTC hour');

  const forged = structuredClone(snapshot);
  forged.snapshotId = randomUUID();
  forged.users[0].recordId = randomUUID();
  forged.timeSlot = '2033-01-01T00:00:00Z';
  forged.users[0].timeSlot = forged.timeSlot;
  forged.users[0].evmAddress = '0x9999999999999999999999999999999999999999';
  const rejected = await send(forged);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  console.log('B09 PASS: forged EVM wallet address rejected');
} finally {
  try {
    // Delete only the exact synthetic record and batch from this execution.
    await prisma.$transaction(async (tx) => {
      await tx.energyRecord.deleteMany({ where: { snapshotId, id: recordId } });
      await tx.energySnapshotImport.deleteMany({ where: { id: snapshotId } });
    });
    console.log('B09 PASS: synthetic energy data cleaned up; original user/wallet preserved');
  } finally {
    await prisma.$disconnect();
  }
}
