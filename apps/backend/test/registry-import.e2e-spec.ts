import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RegistryImportModule } from '../src/registry-import/registry-import.module.js';

const TEST_KEY = 'B08_INTERNAL_TEST_KEY_ONLY_NOT_FOR_DEPLOYMENT_2026';
const payload = JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/user-registry.sample.json', import.meta.url), 'utf8')) as {
  schemaVersion: string;
  users: Array<{userId:string;email:string;name:string;physicalAddress:string;xKm:number;yKm:number;reputation:number;preferredEnergyType:string}>;
};

type Row = {
  id: string; email: string; accountOrigin: string; passwordHash: string;
  name: string; physicalAddress: string; xKm: Prisma.Decimal; yKm: Prisma.Decimal;
  reputation: number; preferredEnergyType: string;
};
const rows = new Map<string, Row>();
const db = {
  user: {
    findMany: async ({ where }: { where: { OR: [{ id: { in: string[] } }, { email: { in: string[] } }] } }) =>
      [...rows.values()].filter((row) => where.OR[0].id.in.includes(row.id) ||
        where.OR[1].email.in.some((mail) => mail.toLowerCase() === row.email.toLowerCase())),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { ...data, xKm: new Prisma.Decimal(data.xKm as string), yKm: new Prisma.Decimal(data.yKm as string) } as Row;
      rows.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: {id:string}; data: Record<string, unknown> }) => {
      const prior = rows.get(where.id);
      if (!prior) throw new Error('Unknown user');
      const row = { ...prior, ...data, xKm: new Prisma.Decimal(data.xKm as string), yKm: new Prisma.Decimal(data.yKm as string) } as Row;
      rows.set(where.id, row);
      return row;
    },
  },
  $transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
};

let secret: string | undefined = TEST_KEY;

describe('B08 internal user-registry HTTP API (mocked PostgreSQL)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), RegistryImportModule],
    })
      .overrideProvider(PrismaService).useValue({ client: db })
      .overrideProvider(ConfigService).useValue({ get: (key: string) => key === 'INTERNAL_IMPORT_API_KEY' ? secret : undefined })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(() => { rows.clear(); secret = TEST_KEY; });
  afterAll(async () => { if (app) await app.close(); });

  it('rejects requests without the internal API credential', async () => {
    await request(app.getHttpServer()).post('/internal/users/import').send(payload).expect(403);
    expect(rows.size).toBe(0);
  });

  it('rejects an incorrect internal API credential', async () => {
    await request(app.getHttpServer()).post('/internal/users/import')
      .set('x-internal-api-key', `${TEST_KEY}wrong`).send(payload).expect(403);
    expect(rows.size).toBe(0);
  });

  it('creates and safely reimports canonical registry data', async () => {
    const first = await request(app.getHttpServer()).post('/internal/users/import')
      .set('x-internal-api-key', TEST_KEY).send(payload).expect(200);
    expect(first.body.created).toBe(2);
    const second = await request(app.getHttpServer()).post('/internal/users/import')
      .set('x-internal-api-key', TEST_KEY).send(payload).expect(200);
    expect(second.body.unchanged).toBe(2);
    expect(rows.size).toBe(2);
  });

  it('returns 400 for invalid user-registry input', async () => {
    await request(app.getHttpServer()).post('/internal/users/import')
      .set('x-internal-api-key', TEST_KEY).send({ ...payload, malicious: true }).expect(400);
    expect(rows.size).toBe(0);
  });

  it('fails closed if the internal secret is not configured', async () => {
    secret = undefined;
    await request(app.getHttpServer()).post('/internal/users/import')
      .set('x-internal-api-key', TEST_KEY).send(payload).expect(503);
  });
});
