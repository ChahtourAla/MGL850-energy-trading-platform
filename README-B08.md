# B08 — User Registry Import (NestJS + Prisma 7)

This package contains **new files only**. Apply the small existing-file changes below manually so B01–B07 remain intact. All commands assume Windows PowerShell at the monorepo root.

## Scope and security policy

- Input: raw canonical `UserRegistry` JSON produced by the Python Data Generator, validated against `packages/shared/schemas/user-registry.schema.json` through B05 `ContractValidator`.
- Endpoint: `POST /internal/users/import`, protected by a separate `x-internal-api-key` secret. A regular user JWT does **not** authorize imports.
- Stable UUIDs: the JSON `userId` becomes PostgreSQL `users.id`.
- New imported rows are `accountOrigin = SIMULATED` and `passwordHash = !SIMULATED_ACCOUNT_NO_LOGIN!`. They **cannot sign in**. This is intentional; a generated registry does not contain a password or user-consented credentials.
- Existing `REGISTERED` user rows remain unchanged if their UUID and normalized email match; a mismatched UUID/email is a **409**, never a silent merge.
- Re-imported `SIMULATED` records can update only profile fields. Password hashes and Hedera wallet records are never changed.
- JSON wallet identifiers (`evmAddress`, `hederaAccountId`) are rejected. Wallets must originate from B07; the wallet-enriched registry used by the Python snapshot generator must be **exported from trusted DB state later**, not imported as asserted custody data.
- One SQL transaction per batch, Prisma `Serializable` isolation. A validation/identity conflict rolls back the whole request. Maximum 200 users/request; the default Nest/Express JSON parser also has a roughly 100 KiB body limit. Larger datasets will need chunking or a later import-job endpoint.
- No wallet provisioning, no on-chain transactions, no Python service changes and no deletion of real accounts.

## 1. Inspect prerequisites

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git branch --show-current
git status --short
pnpm exec prisma migrate status --config prisma7.config.ts
```

Expected branch: `feature/nestjs-backend`. Commit or set aside any unrelated changes first. Do not run destructive Prisma resets or Docker volume removal.

## 2. Extract

Download `B08-user-registry-import.zip` and run:

```powershell
$patch = Join-Path $HOME 'Downloads\B08-user-registry-import.zip'
if (-not (Test-Path $patch)) { throw 'B08 ZIP not found' }
if (Test-Path 'apps\backend\src\registry-import') { throw 'registry-import already exists; inspect before extracting' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

New source files:

```
apps/backend/src/registry-import/internal-import.guard.ts
apps/backend/src/registry-import/registry-import.controller.ts
apps/backend/src/registry-import/registry-import.module.ts
apps/backend/src/registry-import/registry-import.service.ts
apps/backend/src/registry-import/registry-import.service.spec.ts
apps/backend/test/registry-import.e2e-spec.ts
apps/backend/scripts/registry-import-smoke.mjs
README-B08.md
```

No new npm packages are required: we reuse B05 Ajv, Prisma 7, NestJS and node:crypto.

## 3. Add `accountOrigin` to the Prisma User model

File `database/schema.prisma`: inside `model User`, immediately after the `passwordHash` field, add:

```prisma
  accountOrigin String @default("REGISTERED") @map("account_origin") @db.VarChar(16)
```

The model's existing `@@map("users")` and all other fields must remain unchanged.

Create a migration *draft*:

```powershell
pnpm exec prisma validate --config prisma7.config.ts
pnpm exec prisma migrate dev --config prisma7.config.ts --name user_registry_origin --create-only
```

Locate the new `database/migrations/<timestamp>_user_registry_origin/migration.sql`. It should include a non-destructive `ALTER TABLE "users" ADD COLUMN "account_origin" VARCHAR(16) NOT NULL DEFAULT 'REGISTERED';` (exact formatting may differ). Append this SQL **to the new migration only**:

```sql
ALTER TABLE "users"
ADD CONSTRAINT "users_account_origin_allowed"
CHECK ("account_origin" IN ('REGISTERED', 'SIMULATED'));
```

This default marks all existing B06/B07 users as `REGISTERED`. Apply migration and generate client:

```powershell
pnpm exec prisma migrate dev --config prisma7.config.ts
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm exec prisma generate --config prisma7.config.ts
```

Do not edit the already-applied B04/B07 migration files.

## 4. Update UsersService's selected fields

File `apps/backend/src/users/users.service.ts`, inside `AUTH_USER_SELECT` add:

```typescript
  accountOrigin: true,
```

Leave `wallet` and `walletProvisioning` selections from B07 unchanged. This ensures B06 authentication and the JWT guard can identify simulated accounts.

## 5. Ensure simulated accounts cannot log in or use a JWT

File `apps/backend/src/auth/auth.service.ts`, in the `login` method change the *existing* missing-user check:

```typescript
if (!user) {
```

to:

```typescript
if (!user || user.accountOrigin === 'SIMULATED') {
```

Preserve the existing dummy Argon2 work and generic `Invalid email or password` response inside that block. Do not modify registration or any password hashes.

File `apps/backend/src/auth/jwt-auth.guard.ts` change the existing post-lookup check:

```typescript
if (!user) {
```

to:

```typescript
if (!user || user.accountOrigin === 'SIMULATED') {
```

Existing JWT test stubs without `accountOrigin` remain treated as registered for the specific tests; actual DB records have the new NOT NULL column.

## 6. Environment configuration

File `apps/backend/src/config/environment.schema.ts`, in the existing Zod object add:

```typescript
INTERNAL_IMPORT_API_KEY: z.string().min(32).optional(),
```

The setting is optional so the ordinary backend can start without enabling imports. In that state, the B08 route fails closed with HTTP 503. **A request cannot import without a configured 32+ character secret.**

Add to root `.env.example` (no real key):

```
# INTERNAL_IMPORT_API_KEY=generate_a_unique_random_secret
```

Add the real secret to the ignored root `.env` using this PowerShell command (it will not overwrite an existing key):

```powershell
if (-not (Select-String -Path '.env' -Pattern '^INTERNAL_IMPORT_API_KEY=' -Quiet)) {
  $bytes = [byte[]]::new(48)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $secret = [Convert]::ToBase64String($bytes)
  Add-Content -Path '.env' -Value "INTERNAL_IMPORT_API_KEY=$secret"
  Remove-Variable secret
  Write-Host 'New internal import key configured (secret not displayed).'
}
```

Use HTTPS if the internal endpoint is ever accessed outside localhost. Don't expose it on the public Internet, or share the key with end-users.

## 7. Register the new module

File `apps/backend/src/app.module.ts` add:

```typescript
import { RegistryImportModule } from './registry-import/registry-import.module.js';
```

Add `RegistryImportModule` inside the existing root `@Module({ imports: [...] })` list, alongside `ContractsModule`, `PrismaModule`, `AuthModule`, and `HealthModule`. Preserve all existing imports and configuration options.

## 8. Run automated checks

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend exec vitest run src/registry-import/registry-import.service.spec.ts test/registry-import.e2e-spec.ts
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend test:e2e
pnpm --filter @energy-trading/backend lint
```

B08 adds 10 service tests + 5 HTTP tests = **15 new tests**. Target full suite: **99 tests** (84 previous + 15). These targets have **not been executed against your Windows checkout**.

The B08 test data uses the canonical fixture and mocked Prisma, so it doesn't need a live Hedera operator or actual PostgreSQL.

## 9. Real PostgreSQL HTTP smoke test

Start the backend in Terminal 1 (restart after changing `.env`):

```powershell
pnpm --filter @energy-trading/backend start:dev
```

In Terminal 2:

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/registry-import-smoke.mjs
}
finally {
  Pop-Location
}
```

Expected pass lines: unauthorized import blocked; imported simulated users have disabled credentials; simulated account login rejected; idempotent second import; permitted simulated-profile update; identity collision rejected; synthetic records cleaned up.

The smoke script generates random UUIDs and emails. It cleans up only its own simulated records; it never deletes existing registered users or wallets.

## 10. Optional: import the *actual Python fixture* from PowerShell

The smoke script deliberately uses synthetic IDs to avoid polluting real user data. To load the two canonical household fixture accounts into the development database (persistent records), restart the backend with `INTERNAL_IMPORT_API_KEY` configured, then run:

```powershell
$secretLine = Get-Content '.env' | Where-Object { $_ -match '^INTERNAL_IMPORT_API_KEY=' } | Select-Object -Last 1
if (-not $secretLine) { throw 'Missing INTERNAL_IMPORT_API_KEY' }
$key = ($secretLine -split '=', 2)[1]
try {
  $body = Get-Content 'packages/shared/fixtures/user-registry.sample.json' -Raw
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3001/internal/users/import' `
    -Headers @{ 'x-internal-api-key' = $key } `
    -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 5
}
finally { Remove-Variable key -ErrorAction SilentlyContinue }
```

First import should create two rows, later imports should be unchanged (unless you intentionally changed simulated profiles). These users **cannot log in** and **have no Hedera wallet**. That is expected at B08. B09/B10 must handle how to produce wallet-enriched registries from trusted database records before generating energy snapshots. Do **not** insert fake wallet addresses.

## 11. Real Python Data Generator → NestJS integration (recommended)

The repository's `services/data-generator/config/user-registry-config.json` generates **12** deterministic simulated users by default. This is small enough for B08. With the backend running, do:

```powershell
$repoRoot = (Get-Location).Path
$env:PYTHONPATH = "$repoRoot\packages\shared\python;$repoRoot\services\data-generator"
$registryFile = Join-Path $env:TEMP ("b08-users-" + [guid]::NewGuid().ToString('N') + '.json')

python -m data_generator.cli generate-users `
  --config services/data-generator/config/user-registry-config.json `
  --output $registryFile
if ($LASTEXITCODE -ne 0) { throw 'Python user generation failed' }

node apps/backend/scripts/validate-contract.mjs user-registry $registryFile
if ($LASTEXITCODE -ne 0) { throw 'B05 user-registry validation failed' }

$line = Get-Content .env | Where-Object { $_ -match '^INTERNAL_IMPORT_API_KEY=' } | Select-Object -Last 1
if (-not $line) { throw 'Missing internal import key' }
$key = ($line -split '=', 2)[1]
try {
  $body = Get-Content $registryFile -Raw
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3001/internal/users/import' `
    -Headers @{ 'x-internal-api-key' = $key } -ContentType 'application/json' -Body $body |
    ConvertTo-Json -Depth 5
}
finally {
  Remove-Variable key -ErrorAction SilentlyContinue
  Remove-Item $registryFile -ErrorAction SilentlyContinue
}
```

Run the same generator/import again to confirm idempotence. The 12 generated simulated users are **persisted intentionally** for B09 and do not have passwords or Hedera wallets. You must not fabricate them. Because the Python snapshot generator requires wallet-enriched registry data, B08 alone does not make these simulated households eligible for blockchain trading.

## 12. Commit

```powershell
git diff --check
git status --short
git check-ignore -v .env

git add README-B08.md
git add apps/backend/src/registry-import
git add apps/backend/test/registry-import.e2e-spec.ts
git add apps/backend/scripts/registry-import-smoke.mjs
git add apps/backend/src/app.module.ts
git add apps/backend/src/auth/auth.service.ts
git add apps/backend/src/auth/jwt-auth.guard.ts
git add apps/backend/src/users/users.service.ts
git add apps/backend/src/config/environment.schema.ts
git add database/schema.prisma
git add database/migrations
git add .env.example

git diff --cached --check
git diff --cached --stat
git commit -m 'feat(backend): add safe user registry import'
git status --short
```

Do not use `git add .` because unrelated agent-tool files may exist in the working tree. LF/CRLF notices on Windows are informational. Never commit `.env`.

## B08 complete when

- Prisma migration is current and generated client compiled.
- 15 B08 tests and all prior tests pass.
- A real PostgreSQL import and second idempotent import pass.
- 409 collision handling and internal endpoint authorization work.
- Existing B06/B07 wallets and credentials are untouched.
- Code is committed.
