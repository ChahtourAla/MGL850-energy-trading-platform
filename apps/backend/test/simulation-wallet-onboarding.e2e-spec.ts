import 'reflect-metadata';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WalletsService } from '../src/wallets/wallets.service.js';
import { SimulationWalletOnboardingModule } from '../src/simulation-wallets/simulation-wallet-onboarding.module.js';

const KEY = 'B10_ONLY_TEST_SECRET_DIFFERENT_FROM_IMPORT_KEY_2026';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

type Row = {
  id: string; accountOrigin: string;
  wallet: { hederaAccountId: string; evmAddress: string } | null;
  walletProvisioning: { state: string } | null;
};
const users = new Map<string, Row>();
const config = new Map<string, string>();
let broadcasts = 0;
let reconciliations = 0;
const db = {
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => users.get(id)).filter((value): value is Row => !!value),
    findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
  },
};
const walletService = {
  getPublicWallet: async (id: string) => {
    const row = users.get(id)!;
    if (row.wallet) return { status: 'READY' as const, ...row.wallet };
    if (row.walletProvisioning) return { status: 'NEEDS_RECONCILIATION' as const };
    return { status: 'NOT_PROVISIONED' as const };
  },
  provision: async (id: string) => {
    broadcasts += 1;
    const wallet = { hederaAccountId: '0.0.123456', evmAddress: '0x1111111111111111111111111111111111111111' };
    users.get(id)!.wallet = wallet;
    return { status: 'READY' as const, ...wallet };
  },
  reconcile: async (_id: string) => {
    reconciliations += 1;
    return { status: 'NEEDS_RECONCILIATION' as const };
  },
};

describe('B10 simulation wallet administration HTTP (mocked B07 + Prisma)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), SimulationWalletOnboardingModule],
    })
      .overrideProvider(PrismaService).useValue({ client: db })
      .overrideProvider(WalletsService).useValue(walletService)
      .overrideProvider(ConfigService).useValue({ get: (key: string) => config.get(key) })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    config.clear(); users.clear(); broadcasts = 0; reconciliations = 0;
    config.set('SIMULATION_WALLET_ADMIN_KEY', KEY);
    config.set('SIMULATION_WALLET_ONBOARDING_ENABLED', 'true');
    config.set('WALLET_PROVISIONING_ENABLED', 'true');
    config.set('HEDERA_NETWORK', 'testnet');
    users.set(U1, { id: U1, accountOrigin: 'SIMULATED', wallet: null, walletProvisioning: null });
    users.set(U2, { id: U2, accountOrigin: 'REGISTERED', wallet: null, walletProvisioning: null });
    users.set(U3, { id: U3, accountOrigin: 'SIMULATED', wallet: null, walletProvisioning: { state: 'NEEDS_RECONCILIATION' } });
  });
  afterAll(async () => { if (app) await app.close(); });

  const post = (route: string, body: unknown, key?: string) => {
    const r = request(app.getHttpServer()).post(`/internal/simulation/wallets/${route}`);
    if (key) r.set('x-simulation-wallet-key', key);
    return r.send(body);
  };

  it('rejects all routes without a separate admin key', async () => {
    await post('plan', { userIds: [U1] }).expect(403);
    await post('provision', { userId: U1, confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${U1}` }).expect(403);
    await post('reconcile', { userId: U3 }).expect(403);
    expect(broadcasts).toBe(0);
  });
  it('rejects a different service key', async () => {
    await post('plan', { userIds: [U1] }, `${KEY}-wrong`).expect(403);
  });
  it('fails closed when the administrator credential is unset', async () => {
    config.delete('SIMULATION_WALLET_ADMIN_KEY');
    await post('plan', { userIds: [U1] }, KEY).expect(503);
  });
  it('provides a read-only preview for simulated households', async () => {
    const reply = await post('plan', { userIds: [U1, U3] }, KEY).expect(200);
    expect(reply.body).toMatchObject({ total: 2, notProvisioned: 1, pending: 1 });
    expect(JSON.stringify(reply.body)).not.toContain('privateKey');
    expect(broadcasts).toBe(0);
  });
  it('rejects unsafe creation without the per-user confirmation', async () => {
    await post('provision', { userId: U1, confirmation: 'YES' }, KEY).expect(400);
    expect(broadcasts).toBe(0);
  });
  it('creates one verified simulated wallet and is safe to call again', async () => {
    const body = { userId: U1, confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${U1}` };
    const first = await post('provision', body, KEY).expect(200);
    expect(first.body).toMatchObject({ userId: U1, status: 'READY', hederaAccountId: '0.0.123456' });
    const again = await post('provision', body, KEY).expect(200);
    expect(again.body.status).toBe('READY');
    expect(broadcasts).toBe(1);
  });
  it('cannot create a wallet for a registered user via the simulation endpoint', async () => {
    await post('provision', { userId: U2, confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${U2}` }, KEY).expect(403);
    expect(broadcasts).toBe(0);
  });
  it('can reconcile a previous attempt even when NEW creations are disabled', async () => {
    config.set('SIMULATION_WALLET_ONBOARDING_ENABLED', 'false');
    const result = await post('reconcile', { userId: U3 }, KEY).expect(200);
    expect(result.body).toMatchObject({ userId: U3, status: 'NEEDS_RECONCILIATION' });
    expect(broadcasts).toBe(0);
    expect(reconciliations).toBe(1);
  });
});
