import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  beforeAll, afterAll, beforeEach, describe, it, expect,
} from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type StubUser = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  physicalAddress: string;
  xKm: { toNumber: () => number };
  yKm: { toNumber: () => number };
  preferredEnergyType: string;
  reputation: number;
  createdAt: Date;
  updatedAt: Date;
};

const registration = {
  name: 'Solar Household',
  email: '  SOLAR@example.com ',
  password: 'correct horse battery staple 2026!',
  physicalAddress: 'Simulated Street 1',
  xKm: 2.5,
  yKm: 4,
  preferredEnergyType: 'SOLAR',
};

describe('B06 Authentication API (e2e; Prisma mocked)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const byEmail = new Map<string, StubUser>();

  const prismaStub = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.email) return byEmail.get(where.email) ?? null;
        if (where.id) return [...byEmail.values()].find((u) => u.id === where.id) ?? null;
        return null;
      },
      create: async ({ data }: {
        data: {
          email: string;
          name: string;
          passwordHash: string;
          physicalAddress: string;
          xKm: string;
          yKm: string;
          preferredEnergyType: string;
          reputation: number;
        };
      }) => {
        if (byEmail.has(data.email)) throw new Error('Duplicate in test stub');
        const user: StubUser = {
          ...data,
          id: randomUUID(),
          xKm: { toNumber: () => Number(data.xKm) },
          yKm: { toNumber: () => Number(data.yKm) },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        byEmail.set(user.email, user);
        return user;
      },
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ client: prismaStub })
      // Rate limits are exercised separately on the live API.
      // Avoid making unrelated tests share an in-memory IP counter.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  beforeEach(() => byEmail.clear());
  afterAll(async () => { if (app) await app.close(); });

  it('registers and normalizes email, but does not fabricate a Hedera wallet', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send(registration)
      .expect(201);
    expect(res.body.user.email).toBe('solar@example.com');
    expect(res.body.user.walletStatus).toBe('NOT_PROVISIONED');
    expect(res.body.user.userId).toBeTruthy();
    expect(res.body.user.reputation).toBe(50);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(registration.password);
    expect(byEmail.get('solar@example.com')?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('does not permit duplicate emails differing only in case', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(registration).expect(201);
    await request(app.getHttpServer()).post('/auth/register')
      .send({ ...registration, email: 'solar@EXAMPLE.com' })
      .expect(409);
  });

  it('rejects invalid profile, weak password and unexpected fields', async () => {
    await request(app.getHttpServer()).post('/auth/register')
      .send({ ...registration, xKm: 'not a number' }).expect(400);
    await request(app.getHttpServer()).post('/auth/register')
      .send({ ...registration, password: 'short' }).expect(400);
    await request(app.getHttpServer()).post('/auth/register')
      .send({ ...registration, unknown: true }).expect(400);
  });

  it('returns a signed, short-lived token after successful login', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(registration).expect(201);
    const res = await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'SOLAR@EXAMPLE.COM', password: registration.password })
      .expect(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.expiresIn).toBe(900);
    const payload = await jwt.verifyAsync<{ sub: string; tokenType: string }>(res.body.accessToken);
    expect(payload.sub).toBe(res.body.user.userId);
    expect(payload.tokenType).toBe('access');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('returns the same generic error for wrong password and unknown email', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(registration).expect(201);
    const wrong = await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'solar@example.com', password: 'wrong' }).expect(401);
    const missing = await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'missing@example.com', password: 'wrong' }).expect(401);
    expect(wrong.body.message).toBe('Invalid email or password');
    expect(missing.body.message).toBe(wrong.body.message);
  });

  it('rejects GET /users/me with no token or a forged token', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
    await request(app.getHttpServer()).get('/users/me')
      .set('Authorization', 'Bearer invalid.token.signature').expect(401);
  });

  it('returns only own profile for a valid bearer token', async () => {
    await request(app.getHttpServer()).post('/auth/register').send(registration).expect(201);
    const login = await request(app.getHttpServer()).post('/auth/login')
      .send({ email: 'solar@example.com', password: registration.password }).expect(200);
    const res = await request(app.getHttpServer()).get('/users/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);
    expect(res.body.userId).toBe(login.body.user.userId);
    expect(res.body.email).toBe('solar@example.com');
    expect(res.body.walletStatus).toBe('NOT_PROVISIONED');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects tokens for users no longer in the database', async () => {
    const token = await jwt.signAsync({ sub: randomUUID(), tokenType: 'access' });
    await request(app.getHttpServer()).get('/users/me')
      .set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('rejects expired access tokens', async () => {
    const token = await jwt.signAsync({ sub: randomUUID(), tokenType: 'access' }, { expiresIn: -1 });
    await request(app.getHttpServer()).get('/users/me')
      .set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('documents the three B06 endpoints in OpenAPI', async () => {
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(res.body.paths['/auth/register']).toBeDefined();
    expect(res.body.paths['/auth/login']).toBeDefined();
    expect(res.body.paths['/users/me']).toBeDefined();
  });
});
