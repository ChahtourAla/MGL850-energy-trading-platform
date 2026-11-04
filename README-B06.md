# B06 — Authentication and User Management

This is an **overlay**, not a complete repository. It adds new files under `apps/backend/src/auth`, `apps/backend/src/users`, a new HTTP integration test, and a real-database HTTP smoke script. It **does not** overwrite your B01–B05 files. The following merge steps are required.

## Scope / important architectural boundary

- `POST /auth/register`: application user only; **does not create a Hedera wallet yet**. Response `user.walletStatus` is `NOT_PROVISIONED`. The technical spec's atomic registration-plus-wallet workflow is deferred to B07.
- `POST /auth/login`: short-lived 15-minute JWT access token.
- `GET /users/me`: bearer-token-protected profile, never returns password hashes.
- Passwords: Argon2id (`@node-rs/argon2`) and hashed before persistence.
- Duplicate email: normalized in the application and also handled on PostgreSQL `P2002` constraint errors. Current database email unique index is case-sensitive, so other write paths **must** follow the same normalization; B07+ may add a functional lower(email) index if multiple import paths write users.
- Login and registration: local per-IP throttling. In-memory throttling is a development safeguard, not distributed rate limiting for production.
- Existing internal routes are NOT made safe by the `/users/me` guard; all future internal/admin controllers must explicitly apply their own authentication/authorization.

## Step 1 — preflight

From the root of your repo:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
git branch --show-current
git status --short
docker compose --env-file .env -f infra/docker-compose.yml ps
```

Expected branch: `feature/nestjs-backend`; clean worktree and healthy PostgreSQL.

## Step 2 — extract the ZIP

```powershell
$patch = Join-Path $HOME 'Downloads\B06-authentication.zip'
if (-not (Test-Path $patch)) { throw "File not found: $patch" }
if ((Test-Path 'apps\backend\src\auth') -or (Test-Path 'apps\backend\src\users')) {
  throw 'B06 auth/users directories already exist: review before extraction.'
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

It adds these files:

```
apps/backend/src/auth/auth.module.ts
apps/backend/src/auth/auth.controller.ts
apps/backend/src/auth/auth.service.ts
apps/backend/src/auth/auth.types.ts
apps/backend/src/auth/jwt-auth.guard.ts
apps/backend/src/auth/dto/register.dto.ts
apps/backend/src/auth/dto/login.dto.ts
apps/backend/src/users/users.module.ts
apps/backend/src/users/users.service.ts
apps/backend/src/users/users.controller.ts
apps/backend/test/auth.e2e-spec.ts
apps/backend/scripts/auth-smoke.mjs
README-B06.md
```

Note: The users controller is intentionally registered by `AuthModule`, which imports `UsersModule`, avoiding an AuthModule ↔ UsersModule circular dependency for the auth guard. UsersModule still owns the UsersService.

## Step 3 — dependencies

```powershell
pnpm --filter @energy-trading/backend add '@nestjs/jwt@12.0.3' '@nestjs/throttler@6.7.1' '@node-rs/argon2@2.2.2'
```

`@node-rs/argon2` has native prebuilt binaries for Windows, Linux and macOS; no node-gyp installation is normally required.

If pnpm changes `pnpm-workspace.yaml` with `set this to true or false` placeholders, inspect the dependency identity and approve/deny explicitly before proceeding; never commit placeholders.

## Step 4 — generate the private JWT secret (root .env)

The application will refuse to start without it. This block adds a random 48-byte hex secret ONLY when the setting does not yet exist. It does not print the secret.

```powershell
if (-not (Test-Path '.env')) { throw 'Missing root .env from B03' }
if (-not (Select-String -Path '.env' -Pattern '^JWT_ACCESS_SECRET=' -Quiet)) {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    Add-Content -Path '.env' -Value "JWT_ACCESS_SECRET=$secret"
    Remove-Variable secret
    Write-Host 'JWT secret generated in root .env (not printed).'
} else {
    Write-Host 'JWT setting exists; verify it is nonempty and at least 32 characters.'
}
```

If the setting exists but is blank/too short, replace it manually with a random secret. NEVER commit `.env` or paste its contents into chat. Generate and use a separate secret for production; a different secret invalidates old tokens.

In root `.env.example` add a *comment only*:

```dotenv
# JWT_ACCESS_SECRET=generate_a_unique_random_secret_for_each_environment
```

## Step 5 — merge with B05 files (NO full-file overwrites)

### `apps/backend/src/config/environment.schema.ts`

Inside its existing `z.object({ ... })`, add this property alongside `DATABASE_URL`, without removing B03's fields:

```ts
JWT_ACCESS_SECRET: z.string().min(32).optional(),
```

It is intentionally optional at schema parsing time to preserve independent schema tests. AuthModule checks the secret during actual NestJS initialization; if absent or short, NestJS startup fails closed.

### `apps/backend/src/app.module.ts`

Add to imports:

```ts
import { AuthModule } from './auth/auth.module.js';
```

Add `AuthModule` to the existing `@Module({ imports: [ ... ] })` array alongside `PrismaModule`, `ContractsModule`, and `HealthModule`. Keep your existing `ConfigModule.forRoot()` options unchanged. Do not directly import `UsersModule`; AuthModule imports it.

### `apps/backend/vitest.config.ts`

Inside your existing `test: { ... }` object, add this property, leaving all existing settings unchanged:

```ts
env: {
  JWT_ACCESS_SECRET: 'B06_ONLY_STATIC_TEST_SECRET_2026_DO_NOT_USE_IN_RUNNING_SERVER',
},
```

This is a **test-only** value. It allows all 62 existing tests, including those initializing AppModule without local `.env`, to continue running. NEVER use it for an actual server or deployment.

### `apps/backend/src/app.setup.ts`

In the existing Swagger `new DocumentBuilder()` fluent chain, add `.addBearerAuth()` before `.build()`. This enables JWT bearer authorization in Swagger UI.

## Step 6 — build and tests

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend exec vitest run test/auth.e2e-spec.ts
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend test:e2e
pnpm --filter @energy-trading/backend lint
```

Target: **10 B06 HTTP tests** and **72 backend tests total** (62 previous + 10 B06). Counts are targets, not verified on your local environment.

## Step 7 — live PostgreSQL HTTP smoke test

Check PostgreSQL is healthy and start NestJS in another PowerShell terminal:

```powershell
pnpm --filter @energy-trading/backend start:dev
```

Check Swagger `http://localhost:3001/docs`. Then, while the server is running, execute the following **from another terminal at the repository root**:

```powershell
Push-Location apps/backend
try {
    node --env-file=../../.env scripts/auth-smoke.mjs
} finally {
    Pop-Location
}
```

Expected PASS messages: user saved with Argon2id password hash, duplicate email rejected, JWT login succeeded, GET `/users/me` protected, synthetic user cleaned up. No real Hedera account is created.

If smoke test fails, do not reset PostgreSQL or delete tables. Send the error (never your JWT secret/password).

## Step 8 — review and commit

```powershell
git status --short
git diff --check
git check-ignore -v .env
git add README-B06.md apps/backend/src/auth apps/backend/src/users apps/backend/test/auth.e2e-spec.ts apps/backend/scripts/auth-smoke.mjs
git add apps/backend/src/app.module.ts apps/backend/src/config/environment.schema.ts apps/backend/vitest.config.ts apps/backend/src/app.setup.ts
git add apps/backend/package.json pnpm-lock.yaml .env.example
git diff --cached --check
git diff --cached --stat
```

Stage `pnpm-workspace.yaml` separately only if its changes are deliberate and valid.

```powershell
git commit -m 'feat(backend): implement JWT authentication and user profiles'
git status
```

## B06 security boundaries and follow-ups

- Prototyping scope: no email verification, password reset, account lockout, refresh token, MFA, JWT revocation, or distributed rate limiting yet. Do not treat this implementation as production-ready.
- Current registration creates the application user only. In B07 we must integrate Hedera wallet provisioning as a recoverable workflow, and update `walletStatus` based on real wallet state (it is temporarily hardcoded to `NOT_PROVISIONED`).
- The rate limiter is in memory and per IP. It should use distributed storage and account-aware limits in multi-instance deployments. Do not enable `trust proxy` without a known trusted proxy configuration.
- The existing B02 exception filter may log expected 503 responses as errors; that does not indicate a failed test.
- Input validation is applied by the existing B02 global ValidationPipe. Invalid JSON and unexpected DTO properties are rejected.
- User email normalization is app-level. PostgreSQL currently has a case-sensitive unique index; any other user-creation/import path must normalize identically or a future case-insensitive database constraint is needed.
- Do not add unrestricted user listing, private wallet keys, credential values or JWT payloads to API responses or logs.
