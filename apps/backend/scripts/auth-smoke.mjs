// Run with the NestJS server already running:
// Push-Location apps/backend
// node --env-file=../../.env scripts/auth-smoke.mjs
// Pop-Location
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is missing');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const url = process.env.B06_API_URL ?? 'http://localhost:3001';
const email = `b06-${randomUUID()}@example.invalid`;
const password = 'B06-smoke-password-2026-long!';

async function post(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

try {
  const register = await post('/auth/register', {
    name: 'B06 Smoke Test',
    email,
    password,
    physicalAddress: 'Synthetic Address',
    xKm: 2,
    yKm: 3,
    preferredEnergyType: 'SOLAR',
  });
  assert.equal(register.status, 201, JSON.stringify(register.data));
  assert.equal(register.data.user.walletStatus, 'NOT_PROVISIONED');
  assert.equal(register.data.user.email, email);
  assert.ok(!JSON.stringify(register.data).includes('passwordHash'));

  const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
  assert.ok(stored.passwordHash.startsWith('$argon2id$'));
  assert.notEqual(stored.passwordHash, password);
  console.log('B06 PASS: user persisted with an Argon2id password hash');

  const duplicate = await post('/auth/register', {
    name: 'Duplicate', email, password,
    physicalAddress: 'Synthetic Address', xKm: 2, yKm: 3,
    preferredEnergyType: 'SOLAR',
  });
  assert.equal(duplicate.status, 409);
  console.log('B06 PASS: duplicate email rejected');

  const login = await post('/auth/login', { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.tokenType, 'Bearer');
  assert.equal(login.data.expiresIn, 900);
  assert.ok(login.data.accessToken);
  console.log('B06 PASS: JWT login succeeded');

  const unauthorized = await fetch(`${url}/users/me`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${url}/users/me`, {
    headers: { Authorization: `Bearer ${login.data.accessToken}` },
  });
  assert.equal(authorized.status, 200);
  const profile = await authorized.json();
  assert.equal(profile.userId, stored.id);
  assert.ok(!JSON.stringify(profile).includes('passwordHash'));
  console.log('B06 PASS: /users/me requires JWT and never returns password hashes');
} finally {
  try {
    await prisma.user.deleteMany({ where: { email } });
    console.log('B06 PASS: synthetic user cleaned up');
  } finally {
    await prisma.$disconnect();
  }
}
