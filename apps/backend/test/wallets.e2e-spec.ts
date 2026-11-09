import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { HederaWalletGateway } from '../src/wallets/hedera-wallet.gateway.js';
import { WalletCryptoService } from '../src/wallets/wallet-crypto.service.js';

type Row = Record<string, unknown>;
const users = new Map<string, Row>();
const stages = new Map<string, Row>();
const wallets = new Map<string, Row>();
const TEST_KEY = Buffer.alloc(32, 25).toString('base64');
const crypto = new WalletCryptoService({
  get: (name: string) => (name === 'WALLET_ENCRYPTION_KEY_B64' ? TEST_KEY : undefined),
} as never);

const database = {
  user: {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
      const row = where.id
        ? users.get(where.id)
        : [...users.values()].find((u) => u.email === where.email);
      if (!row) return null;
      return {
        ...row,
        wallet: wallets.has(row.id as string) ? { id: wallets.get(row.id as string)?.id } : null,
        walletProvisioning: stages.has(row.id as string)
          ? { state: stages.get(row.id as string)?.state }
          : null,
      };
    },
    create: async ({ data }: { data: Row }) => {
      const id = randomUUID();
      const row = {
        ...data,
        id,
        xKm: { toNumber: () => Number(data.xKm) },
        yKm: { toNumber: () => Number(data.yKm) },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.set(id, row);
      return { ...row, wallet: null, walletProvisioning: null };
    },
  },
  wallet: {
    findUnique: async ({ where }: { where: { userId: string } }) =>
      wallets.get(where.userId) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...data };
      wallets.set(data.userId as string, row);
      return row;
    },
  },
  walletProvisioning: {
    findUnique: async ({ where }: { where: { userId: string } }) =>
      stages.get(where.userId) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...data };
      stages.set(data.userId as string, row);
      return row;
    },
    update: async ({ where, data }: { where: { userId: string }; data: Row }) => {
      const row = stages.get(where.userId);
      if (!row) throw new Error('Missing staging record');
      const updated = { ...row, ...data };
      stages.set(where.userId, updated);
      return updated;
    },
    delete: async ({ where }: { where: { userId: string } }) => {
      const row = stages.get(where.userId);
      stages.delete(where.userId);
      return row;
    },
  },
  $transaction: async <T>(run: (tx: typeof database) => Promise<T>) => run(database),
};

let failSubmit = false;
let receiptId: string | null = null;
let submits = 0;
const gateway = {
  prepare: () => ({
    privateKey: 'TEST_ONLY_SECRET_ECDSA_KEY',
    publicKey: 'TEST_ONLY_PUBLIC_KEY',
    evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
    transactionId: `0.0.1234@${randomUUID()}`,
  }),
  submit: async () => {
    submits += 1;
    if (failSubmit) throw new Error('Simulated unknown Hedera result');
    return { hederaAccountId: '0.0.9876543' };
  },
  findCreatedAccount: async () => receiptId,
};

const form = {
  name: 'B07 Test',
  email: 'b07@example.invalid',
  password: 'B07-test-password-long!',
  physicalAddress: 'Simulated Street 1',
  xKm: 2.5,
  yKm: 4,
  preferredEnergyType: 'SOLAR',
};

describe('B07 wallet HTTP API (mocked Hedera + Prisma)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Configure the test environment BEFORE loading AppModule.
    process.env.WALLET_PROVISIONING_ENABLED = 'true';

    // Dynamic import ensures NestJS reads the test configuration
    // after the environment variable has been initialized.
    const { AppModule } = await import('../src/app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ client: database })
      .overrideProvider(HederaWalletGateway)
      .useValue(gateway)
      .overrideProvider(WalletCryptoService)
      .useValue(crypto)
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    users.clear();
    stages.clear();
    wallets.clear();
    failSubmit = false;
    receiptId = null;
    submits = 0;
    process.env.WALLET_PROVISIONING_ENABLED = 'true';
  });
  afterAll(async () => {
    delete process.env.WALLET_PROVISIONING_ENABLED;
    if (app) await app.close();
  });

  async function createAuthToken(): Promise<{ token: string; userId: string }> {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send(form)
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: form.email, password: form.password })
      .expect(200);
    return {
      token: login.body.accessToken as string,
      userId: registration.body.user.userId as string,
    };
  }

  it('requires a JWT for all three wallet endpoints', async () => {
    await request(app.getHttpServer()).get('/users/me/wallet').expect(401);
    await request(app.getHttpServer()).post('/users/me/wallet/provision').expect(401);
    await request(app.getHttpServer()).post('/users/me/wallet/reconcile').expect(401);
  });
  it('starts with NOT_PROVISIONED and no private wallet fields', async () => {
    const { token } = await createAuthToken();
    const response = await request(app.getHttpServer())
      .get('/users/me/wallet')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({ status: 'NOT_PROVISIONED' });
  });
  it('creates a wallet exactly once and returns only public identifiers', async () => {
    const { token, userId } = await createAuthToken();
    const first = await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.status).toBe('READY');
    expect(first.body.hederaAccountId).toBe('0.0.9876543');
    expect(submits).toBe(1);
    expect(stages.size).toBe(0);
    const stored = wallets.get(userId);
    expect(stored?.encryptedPrivateKey).not.toBe('TEST_ONLY_SECRET_ECDSA_KEY');
    expect(crypto.decrypt(userId, stored as never)).toBe('TEST_ONLY_SECRET_ECDSA_KEY');
    expect(JSON.stringify(first.body)).not.toContain('PrivateKey');
    await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(submits).toBe(1);
    const profile = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(profile.body.walletStatus).toBe('READY');
  });
  it('preserves an uncertain network submission without creating another account', async () => {
    failSubmit = true;
    const { token, userId } = await createAuthToken();
    await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    expect(stages.get(userId)?.state).toBe('NEEDS_RECONCILIATION');
    expect(stages.get(userId)?.transactionId).toBeTruthy();
    await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(submits).toBe(1);
  });
  it('reconciles the recorded Hedera receipt instead of resending', async () => {
    failSubmit = true;
    const { token } = await createAuthToken();
    await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    receiptId = '0.0.9876543';
    const recovered = await request(app.getHttpServer())
      .post('/users/me/wallet/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(recovered.body.status).toBe('READY');
    expect(submits).toBe(1);
    expect(stages.size).toBe(0);
  });
  it('does not fabricate success if reconciliation has no receipt', async () => {
    failSubmit = true;
    const { token } = await createAuthToken();
    await request(app.getHttpServer())
      .post('/users/me/wallet/provision')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    const recovered = await request(app.getHttpServer())
      .post('/users/me/wallet/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(recovered.body.status).toBe('NEEDS_RECONCILIATION');
    expect(submits).toBe(1);
  });
  it('documents the wallet endpoints in Swagger', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(response.body.paths['/users/me/wallet']).toBeDefined();
    expect(response.body.paths['/users/me/wallet/provision']).toBeDefined();
    expect(response.body.paths['/users/me/wallet/reconcile']).toBeDefined();
  });
});
