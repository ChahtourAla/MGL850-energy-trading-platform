import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const root = resolve(import.meta.dirname, '../../../');
const source = (path) => readFileSync(resolve(root, path), 'utf8');
const module = source('apps/backend/src/trading-api/trading-api.module.ts');
const controller = source('apps/backend/src/trading-api/trading-api.controller.ts');
const delegate = source('apps/backend/src/trading-api/trading-api-jwt.guard.ts');
const authModule = source('apps/backend/src/auth/auth.module.ts');

test('guard uses AuthModule-exported token with existing JWT config', () => {
  assert.match(authModule, /exports:\s*\[JwtAuthGuard\]/);
  assert.match(module, /imports:\s*\[[^\]]*AuthModule/);
  assert.match(module, /providers:\s*\[[^\]]*TradingApiJwtGuard/);
  assert.doesNotMatch(module, /providers:\s*\[[^\]]*JwtAuthGuard\s*[,\]]/);
});

test('participant routes always invoke delegating guard, never direct JwtAuthGuard', () => {
  assert.match(controller, /@UseGuards\(TradingApiJwtGuard\)/);
  assert.doesNotMatch(controller, /@UseGuards\(JwtAuthGuard\)/);
  assert.match(delegate, /@Inject\(JwtAuthGuard\)/);
  assert.match(delegate, /return this\.existingAuth\.canActivate\(context\)/);
  assert.doesNotMatch(delegate, /return\s+true\s*;/);
});
