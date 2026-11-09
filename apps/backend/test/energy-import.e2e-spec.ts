import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EnergyImportModule } from '../src/energy-import/energy-import.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const KEY = 'B09_INTERNAL_TEST_KEY_ONLY_DO_NOT_USE_IN_PRODUCTION';
const original = JSON.parse(readFileSync(
  new URL('../../../packages/shared/fixtures/energy-snapshot.sample.json', import.meta.url),
  'utf8',
)) as {
  schemaVersion: string; snapshotId: string; timeSlot: string; generatorVersion: string;
  users: Array<{recordId:string;userId:string;timeSlot:string;evmAddress:string}>;
};
const fixture = () => structuredClone(original);

type Batch = { id: string; timeSlot: Date; payloadSha256: string; recordCount: number; schemaVersion: string; generatorVersion: string };
type Row = { id: string; userId: string; snapshotId: string; timeSlot: Date; productionWh: bigint; consumptionWh: bigint; netEnergyWh: bigint; marketRole: string; availableEnergyWh: bigint; requiredEnergyWh: bigint; energyType: string | null; askPriceMicrousdPerKwh: bigint | null; maxPriceMicrousdPerKwh: bigint | null };
const batches = new Map<string, Batch>();
const energy = new Map<string, Row>();
const wallets = new Map<string, string>();
const tx = {
  energySnapshotImport: {
    findMany: async ({ where }: { where: { OR: [{ id: string }, { timeSlot: Date }] } }) =>
      [...batches.values()].filter((b) => b.id === where.OR[0].id ||
        b.timeSlot.getTime() === where.OR[1].timeSlot.getTime()),
    create: async ({ data }: { data: Batch }) => { batches.set(data.id, data); return data; },
  },
  energyRecord: {
    findMany: async ({ where }: { where: { timeSlot: Date } }) =>
      [...energy.values()].filter((r) => r.timeSlot.getTime() === where.timeSlot.getTime()),
    count: async ({ where }: { where: { timeSlot: Date } }) =>
      [...energy.values()].filter((r) => r.timeSlot.getTime() === where.timeSlot.getTime()).length,
    createMany: async ({ data }: { data: Row[] }) => {
      data.forEach((r) => { energy.set(r.id, r); });
      return { count: data.length };
    },
  },
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => wallets.has(id)).map((id) => ({
        id, wallet: wallets.get(id) === '' ? null : { evmAddress: wallets.get(id)! },
      })),
  },
};
const db = { $transaction: async <T>(callback: (context: typeof tx) => Promise<T>): Promise<T> => callback(tx) };
let secret: string | undefined = KEY;

describe('B09 internal energy import HTTP API (mocked Prisma)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EnergyImportModule],
    })
      .overrideProvider(PrismaService).useValue({ client: db })
      .overrideProvider(ConfigService).useValue({
        get: (key: string) => key === 'INTERNAL_IMPORT_API_KEY' ? secret : undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    batches.clear();
    energy.clear();
    wallets.clear();
    for (const record of original.users) wallets.set(record.userId, record.evmAddress);
    secret = KEY;
  });
  afterAll(async () => { if (app) await app.close(); });

  const post = (payload: unknown, key?: string) => {
    const req = request(app.getHttpServer()).post('/internal/energy/import');
    if (key) req.set('x-internal-api-key', key);
    return req.send(payload);
  };

  it('requires an internal credential', async () => {
    await post(fixture()).expect(403);
    expect(energy.size).toBe(0);
  });

  it('rejects a wrong internal credential', async () => {
    await post(fixture(), `${KEY}-wrong`).expect(403);
    expect(batches.size).toBe(0);
  });

  it('creates two records and re-imports idempotently', async () => {
    const one = await post(fixture(), KEY).expect(200);
    expect(one.body).toMatchObject({ created: 2, unchanged: 0, source: 'energy-snapshot' });
    const two = await post(fixture(), KEY).expect(200);
    expect(two.body).toMatchObject({ created: 0, unchanged: 2 });
    expect(energy.size).toBe(2);
  });

  it('rejects malformed data using the shared B05 validator', async () => {
    await post({ ...fixture(), unauthorized: true }, KEY).expect(400);
    expect(batches.size).toBe(0);
  });

  it('rejects an address not backed by a B07 wallet', async () => {
    wallets.set(original.users[0].userId, '');
    await post(fixture(), KEY).expect(409);
    expect(energy.size).toBe(0);
  });
});
