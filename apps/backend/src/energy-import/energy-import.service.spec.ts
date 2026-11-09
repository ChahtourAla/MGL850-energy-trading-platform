import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContractValidator } from '../contracts/contract-validator.js';
import type { EnergySnapshot } from '../contracts/types.js';
import { EnergyImportService } from './energy-import.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const fixture = JSON.parse(readFileSync(
  new URL('../../../../packages/shared/fixtures/energy-snapshot.sample.json', import.meta.url),
  'utf8',
)) as EnergySnapshot;
const copy = (): EnergySnapshot => structuredClone(fixture);

type Row = {
  id: string; userId: string; timeSlot: Date; snapshotId: string | null;
  productionWh: bigint; consumptionWh: bigint; netEnergyWh: bigint;
  marketRole: string; availableEnergyWh: bigint; requiredEnergyWh: bigint;
  energyType: string | null; askPriceMicrousdPerKwh: bigint | null;
  maxPriceMicrousdPerKwh: bigint | null;
};
type Batch = {
  id: string; timeSlot: Date; schemaVersion: string; generatorVersion: string;
  payloadSha256: string; recordCount: number;
};
const rows = new Map<string, Row>();
const batches = new Map<string, Batch>();
const wallets = new Map<string, string>();

// This mock exposes exactly the Prisma calls used by the importer; the
// callback references `tx`, not `typeof db`, avoiding circular TS inference.
const tx = {
  energySnapshotImport: {
    findMany: async ({ where }: { where: { OR: [{ id: string }, { timeSlot: Date }] } }) =>
      [...batches.values()].filter((b) =>
        b.id === where.OR[0].id || b.timeSlot.getTime() === where.OR[1].timeSlot.getTime()),
    create: async ({ data }: { data: Batch }) => {
      batches.set(data.id, data);
      return data;
    },
  },
  energyRecord: {
    findMany: async ({ where }: { where: { timeSlot: Date } }) =>
      [...rows.values()].filter((r) => r.timeSlot.getTime() === where.timeSlot.getTime()),
    count: async ({ where }: { where: { timeSlot: Date } }) =>
      [...rows.values()].filter((r) => r.timeSlot.getTime() === where.timeSlot.getTime()).length,
    createMany: async ({ data }: { data: Row[] }) => {
      for (const row of data) rows.set(row.id, row);
      return { count: data.length };
    },
  },
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => wallets.has(id)).map((id) => ({
        id,
        wallet: wallets.get(id) === '' ? null : { evmAddress: wallets.get(id)! },
      })),
  },
};
const db = { $transaction: async <T>(fn: (context: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
const service = new EnergyImportService(
  { client: db } as unknown as PrismaService,
  new ContractValidator(),
);

beforeEach(() => {
  rows.clear();
  batches.clear();
  wallets.clear();
  for (const item of fixture.users) wallets.set(item.userId, item.evmAddress);
});

describe('B09 energy snapshot import policy', () => {
  it('imports both records, preserving signed Wh and exact micro-USD prices', async () => {
    const result = await service.importSnapshot(copy());
    expect(result).toMatchObject({ source: 'energy-snapshot', total: 2, created: 2, unchanged: 0 });
    expect(rows.size).toBe(2);
    expect(batches.size).toBe(1);
    expect(rows.get(fixture.users[1].recordId)?.netEnergyWh).toBe(-4000n);
    expect(rows.get(fixture.users[0].recordId)?.askPriceMicrousdPerKwh).toBe(140000n);
  });

  it('re-imports an unchanged snapshot without writing duplicate records', async () => {
    await service.importSnapshot(copy());
    expect(await service.importSnapshot(copy())).toMatchObject({ created: 0, unchanged: 2 });
    expect(rows.size).toBe(2);
  });

  it('treats reordered user records as the same snapshot', async () => {
    await service.importSnapshot(copy());
    const reordered = copy();
    reordered.users.reverse();
    expect(await service.importSnapshot(reordered)).toMatchObject({ unchanged: 2 });
  });

  it('rejects an invalid seller equation before any DB writes', async () => {
    const bad = copy();
    bad.users[0].netEnergyWh = 123;
    await expect(service.importSnapshot(bad)).rejects.toMatchObject({ status: 400 });
    expect(batches.size).toBe(0);
  });

  it('rejects a user UUID missing from the registry atomically', async () => {
    const bad = copy();
    bad.users[0].userId = randomUUID();
    await expect(service.importSnapshot(bad)).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(0);
  });

  it('rejects a household without a B07 wallet', async () => {
    wallets.set(fixture.users[0].userId, '');
    await expect(service.importSnapshot(copy())).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(0);
  });

  it('rejects a forged wallet address even if the user exists', async () => {
    wallets.set(fixture.users[0].userId, '0x9999999999999999999999999999999999999999');
    await expect(service.importSnapshot(copy())).rejects.toMatchObject({ status: 409 });
    expect(batches.size).toBe(0);
  });

  it('rejects a different snapshot ID at the same UTC hour', async () => {
    await service.importSnapshot(copy());
    const changed = copy();
    changed.snapshotId = randomUUID();
    changed.users.forEach((r) => { r.recordId = randomUUID(); });
    await expect(service.importSnapshot(changed)).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(2);
  });

  it('rejects changes to a snapshot already stored under the same ID', async () => {
    await service.importSnapshot(copy());
    const changed = copy();
    changed.users[0].productionWh += 1;
    changed.users[0].netEnergyWh += 1;
    changed.users[0].availableEnergyWh += 1;
    await expect(service.importSnapshot(changed)).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(2);
  });

  it('does not overwrite historical hourly records without snapshot metadata', async () => {
    rows.set(randomUUID(), {
      id: randomUUID(), userId: fixture.users[0].userId,
      timeSlot: new Date(fixture.timeSlot), snapshotId: null,
      productionWh: 0n, consumptionWh: 1n, netEnergyWh: -1n,
      marketRole: 'BUYER', availableEnergyWh: 0n, requiredEnergyWh: 1n,
      energyType: null, askPriceMicrousdPerKwh: null, maxPriceMicrousdPerKwh: 1n,
    });
    await expect(service.importSnapshot(copy())).rejects.toMatchObject({ status: 409 });
    expect(batches.size).toBe(0);
  });

  it('detects missing or tampered persisted rows on retry', async () => {
    await service.importSnapshot(copy());
    rows.delete(fixture.users[0].recordId);
    await expect(service.importSnapshot(copy())).rejects.toMatchObject({ status: 409 });
  });

  it('allows an independent new UTC hour for the same households', async () => {
    await service.importSnapshot(copy());
    const next = copy();
    next.snapshotId = randomUUID();
    next.timeSlot = '2026-10-17T15:00:00Z';
    next.users.forEach((r) => { r.timeSlot = next.timeSlot; r.recordId = randomUUID(); });
    expect(await service.importSnapshot(next)).toMatchObject({ created: 2 });
    expect(rows.size).toBe(4);
    expect(batches.size).toBe(2);
  });

  it('rejects unsupported extras using the existing B05 contract', async () => {
    await expect(service.importSnapshot({ ...copy(), injected: true })).rejects.toMatchObject({ status: 400 });
  });

  it('enforces a strict 200-record import limit before touching PostgreSQL', async () => {
    const many = copy();
    many.users = Array.from({ length: 201 }, (_, i) => ({
      ...many.users[0],
      userId: randomUUID(),
      recordId: randomUUID(),
      evmAddress: `0x${i.toString(16).padStart(40, '0')}`,
    }));
    await expect(service.importSnapshot(many)).rejects.toMatchObject({ status: 400 });
    expect(batches.size).toBe(0);
  });
});
