# B09 — Energy Snapshot Import (NestJS / Prisma 7 / PostgreSQL)

**Status:** implementation overlay for your already-committed B08 backend. New source files are included. Existing files must be merged manually. The 19 B09 tests have been checked for TypeScript syntax, **not executed in your Windows checkout**. B08's previous 99-test baseline plus 19 B09 tests gives a target of **118 tests**.

## 0. Architectural safety decision

Your canonical `EnergySnapshot` (B05 `packages/shared/schemas/energy-snapshot.schema.json`) requires `users[].evmAddress`. The Python generator additionally requires a wallet-enriched `UserRegistry` containing each user's `hederaAccountId` and `evmAddress`. The 12 households imported in B08 do NOT have wallets. Therefore:

- B09 imports only canonical snapshots, not a redesigned energy-only format.
- Every referenced `users.id` must exist and have a real B07 `wallet` row. `users[].evmAddress` must match `wallets.evm_address` (case-insensitive). Input addresses are never persisted as evidence of ownership.
- The 12 B08 households cannot yet produce/import a normal Python snapshot. **Do not invent Hedera account IDs or replace the required EVM addresses with placeholders.** They need a separately authorized simulated-household wallet-onboarding flow first.
- The B09 smoke test uses your existing real B07 Testnet account (e.g. account `0.0.11375973`) and creates *no* new blockchain account. It writes **synthetic** energy for a reserved UTC hour and removes its exact record and batch on completion. The live Testnet transfer/matching process is not involved.

This policy protects downstream matching: a snapshot is data, not authority to impersonate wallets.

## 1. Inspect prerequisites

From your Windows PowerShell repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git branch --show-current
git log -1 --oneline
git status --short
pnpm exec prisma migrate status --config prisma7.config.ts
```

Expected latest B08 commit `455dbc5` on `feature/nestjs-backend`. Untracked `.agents/`, `.claude/`, `.windsurf/`, `skills-lock.json` are unrelated. Commit/stash other changes before extracting. Keep your root `.env` ignored.

## 2. Extract the ZIP (new files only)

Download `B09-energy-snapshot-import.zip` and run:

```powershell
$patch = Join-Path $HOME 'Downloads\B09-energy-snapshot-import.zip'
if (-not (Test-Path $patch)) { throw 'B09 ZIP not found in Downloads' }
if (Test-Path 'apps\backend\src\energy-import') { throw 'B09 folder already exists; inspect before extracting' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

Files added:

```text
apps/backend/src/energy-import/energy-import.service.ts
apps/backend/src/energy-import/energy-import.controller.ts
apps/backend/src/energy-import/energy-import.module.ts
apps/backend/src/energy-import/energy-import.service.spec.ts
apps/backend/test/energy-import.e2e-spec.ts
apps/backend/scripts/energy-import-smoke.mjs
apps/backend/scripts/export-wallet-ready-registry.mjs
README-B09.md
```

No new npm dependencies are required.

## 3. Add the snapshot import metadata model in Prisma

Open `database/schema.prisma`. In your **existing** `model EnergyRecord` add the following two fields (leave every previous field intact):

```prisma
  snapshotId     String?               @map("snapshot_id") @db.Uuid
  snapshotImport EnergySnapshotImport? @relation(fields: [snapshotId], references: [id], onDelete: Restrict)
```

Inside that same `EnergyRecord` model, add the index (alongside its existing `@@unique([userId, timeSlot])` and `@@map("energy_records")`):

```prisma
  @@index([snapshotId])
```

**Append this entirely new model** to `database/schema.prisma`:

```prisma
model EnergySnapshotImport {
  id               String    @id @db.Uuid
  timeSlot         DateTime  @unique @map("time_slot") @db.Timestamptz(3)
  schemaVersion    String    @map("schema_version") @db.VarChar(32)
  generatorVersion String    @map("generator_version") @db.VarChar(32)
  payloadSha256    String    @map("payload_sha256") @db.Char(64)
  recordCount      Int       @map("record_count")
  importedAt       DateTime  @default(now()) @map("imported_at") @db.Timestamptz(3)

  records          EnergyRecord[]

  @@map("energy_snapshot_imports")
}
```

The `snapshotId` field on `energy_records` is intentionally **nullable** so existing historic rows remain valid. New B09 imports always set it. The metadata table provides one immutable snapshot per UTC time slot and records the schema/generator versions plus a SHA-256 digest of the canonical input. The record FK lets downstream matching link stored records back to their snapshot.

Create a **draft** migration, keeping old migrations untouched:

```powershell
pnpm exec prisma validate --config prisma7.config.ts
pnpm exec prisma migrate dev --config prisma7.config.ts --name energy_snapshot_import --create-only
```

Inspect `database/migrations/<timestamp>_energy_snapshot_import/migration.sql`: it should contain `CREATE TABLE "energy_snapshot_imports"`, a nullable `snapshot_id` in `energy_records`, an index, unique index on snapshot hour, and FK from `energy_records.snapshot_id` to `energy_snapshot_imports.id`. **Stop if Prisma proposes dropping or rebuilding unrelated tables.** The new metadata table should be empty, and existing energy records should be preserved.

Optionally append to that new migration:

```sql
ALTER TABLE "energy_snapshot_imports"
  ADD CONSTRAINT "energy_snapshot_imports_record_count_positive"
  CHECK ("record_count" > 0);
```

Apply the approved migration:

```powershell
pnpm exec prisma migrate dev --config prisma7.config.ts
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm exec prisma generate --config prisma7.config.ts
```

## 4. Register the new NestJS module

Open `apps/backend/src/app.module.ts`. Add:

```typescript
import { EnergyImportModule } from './energy-import/energy-import.module.js';
```

Add `EnergyImportModule` inside the existing `@Module({ imports: [...] })` array. **Keep** your B01–B08 modules (`AuthModule`, `RegistryImportModule`, `PrismaModule`, `ContractsModule`, etc.) intact. No changes are needed to B06 auth/JWT or B07 wallet code.

The new protected endpoint is:

```http
POST /internal/energy/import
Content-Type: application/json
x-internal-api-key: <INTERNAL_IMPORT_API_KEY from ignored .env>

<canonical EnergySnapshot JSON>
```

It reuses B08's `InternalImportGuard`, so the existing 32+ character `INTERNAL_IMPORT_API_KEY` in `.env` works. JWTs do not authorize it. Expose this endpoint only on localhost/trusted networks; enable TLS and separate internal network access before deploying beyond your workstation.

### Responses

First import (the sample has 2 users, **provided both have verified wallet DB rows**):

```json
{"source":"energy-snapshot","snapshotId":"...","timeSlot":"2026-10-17T14:00:00Z","total":2,"created":2,"unchanged":0}
```

Identical repeated import:

```json
{"source":"energy-snapshot","snapshotId":"...","timeSlot":"2026-10-17T14:00:00Z","total":2,"created":0,"unchanged":2}
```

HTTP 400: invalid shared schema, invalid energy equation, duplicate users or more than 200 records. HTTP 403: absent/incorrect internal key. HTTP 409: unknown user, missing verified wallet, wallet mismatch, different snapshot at the same hour, or a corrupted existing batch. HTTP 503: guard not configured.

### Important invariants

- Wh and micro-USD prices persist as `bigint`; do not use floating-point currency math.
- Time slots must match the B05 UTC hourly schema; the database enforces unique `(userId, timeSlot)` as before.
- The SHA-256 digest is a consistency fingerprint, **not a digital signature**. Wallet identity comes from the B07 database, not the incoming JSON.
- A repeated snapshot is a **no-op** only if metadata, digest and all stored hourly records agree.
- A different `snapshotId` or payload for an already occupied hour returns 409, **never overwrites history**.
- A transaction uses Prisma `Serializable` isolation and catches unique/serialization conflicts; it does not make blockchain calls.
- Maximum 200 records/request; the NestJS default body parser may also cap HTTP JSON at about 100 KiB. The default 12-household scenario fits this bound.

## 5. Automated verification

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck

pnpm --filter @energy-trading/backend exec vitest run `
  src/energy-import/energy-import.service.spec.ts `
  test/energy-import.e2e-spec.ts

pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

B09 includes **14 service tests + 5 HTTP tests = 19 new tests**. Target: **118/118** backend tests (99 from B08 + 19 from B09) over 15 test files. These numbers are targets, not claimed results. Stop at build or typecheck failures and share the complete error output for an exact patch.

## 6. Real PostgreSQL smoke test using your existing B07 wallet

Ensure the B09 migration has been applied, the root `.env` includes `DATABASE_URL` and `INTERNAL_IMPORT_API_KEY`, and the backend is restarted in Terminal 1:

```powershell
pnpm --filter @energy-trading/backend start:dev
```

In Terminal 2, from the repo root:

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/energy-import-smoke.mjs
}
finally {
  Pop-Location
}
```

This script searches PostgreSQL for one **real B07 wallet** and imports an energy record for its actual `userId` and verified EVM address. It verifies access control, bigint persistence, idempotent retry, conflict protection and forged wallet rejection. The script uses a reserved synthetic future UTC hour, then deletes **only** its own record and snapshot metadata. Your real wallet/user account is preserved. No Hedera fee, private-key handling or wallet provisioning is involved.

If no real wallet row exists, the test will fail closed with an explanatory error; do not create fake wallets to satisfy the test.

## 7. Prepare a real Python-generated snapshot (requires verified wallets for all participants)

The B08 import created **12 SIMULATED households without wallets**, and B06 blocks them from JWT login. Before `generate-snapshot` works for them, a **separately authorized** backend onboarding flow must provision 12 real B07 wallet records safely (including the existing reconciliation behavior). That workflow is **not** added in B09. This is a real integration dependency, not an issue you can fix by inventing EVM addresses.

After wallets have been provisioned, the included `export-wallet-ready-registry.mjs` script exports a read-only, public-identifier-only registry from PostgreSQL. It refuses to write any output if one or more households are missing verified wallets.

From PowerShell at the repo root:

```powershell
$root = (Get-Location).Path
$env:PYTHONPATH = "$root\packages\shared\python;$root\services\data-generator"
$source = Join-Path $env:TEMP 'b08-generated-users.json'
$output = Join-Path $env:TEMP 'b09-wallet-ready-users.json'

if (Test-Path $output) { throw 'Output already exists. Choose a new path rather than overwrite.' }

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/export-wallet-ready-registry.mjs $source $output
}
finally { Pop-Location }
```

**For your current 12 walletless households this should fail safely with `12/12 households have no verified B07 wallet` and no output.** After the wallet onboarding prerequisite is addressed, validate the resulting registry:

```powershell
python -m data_generator.cli validate-users --input $output --require-wallets
```

Then generate a canonical snapshot (using the existing Python generator and B05 contract, unchanged):

```powershell
$slot = '2026-11-09T12:00:00Z'
$dir = Join-Path $env:TEMP ('b09-snapshots-' + [guid]::NewGuid().ToString('N'))

python -m data_generator.cli generate-snapshot `
  --registry $output `
  --config services/data-generator/config/energy-generation-config.json `
  --time-slot $slot `
  --output-dir $dir

$snapshotFile = Join-Path $dir 'energy_snapshot_2026-11-09T12.json'
node apps/backend/scripts/validate-contract.mjs energy-snapshot $snapshotFile
```

With the backend running, import the generated snapshot through the authenticated internal HTTP endpoint:

```powershell
$line = Get-Content .env | Where-Object { $_ -match '^INTERNAL_IMPORT_API_KEY=' } | Select-Object -Last 1
if (-not $line) { throw 'Missing INTERNAL_IMPORT_API_KEY' }
$key = ($line -split '=',2)[1]
try {
  Invoke-RestMethod -Method Post `
    -Uri 'http://127.0.0.1:3001/internal/energy/import' `
    -Headers @{ 'x-internal-api-key' = $key } `
    -ContentType 'application/json' `
    -Body (Get-Content $snapshotFile -Raw) | ConvertTo-Json -Depth 5
}
finally { Remove-Variable key -ErrorAction SilentlyContinue }
```

Running the exact same import twice should yield `created:0` and `unchanged:12` on the second run. These actual 12 snapshot records **persist**; unlike the synthetic smoke test, the HTTP import does not delete them.

## 8. Review and commit B09

```powershell
git status --short
git diff --check
git check-ignore -v .env

git add README-B09.md
git add apps/backend/src/energy-import
git add apps/backend/test/energy-import.e2e-spec.ts
git add apps/backend/scripts/energy-import-smoke.mjs
git add apps/backend/scripts/export-wallet-ready-registry.mjs
git add apps/backend/src/app.module.ts
git add database/schema.prisma
git add database/migrations/<actual_timestamp>_energy_snapshot_import

git diff --cached --check
git diff --cached --stat
git commit -m 'feat(backend): add verified hourly energy snapshot import'
git log -1 --oneline
git status --short
```

Replace `<actual_timestamp>` with your generated migration directory name. Do not use `git add .` to accidentally commit `.agents`, `.claude`, `.windsurf` or `skills-lock.json`. Never commit root `.env` or private wallet keys.

## Scope / next integration decision

This B09 release implements **secure snapshot ingestion and provenance tracking**. It does not provision wallets for simulated users, modify shared schema V1, run the Python generator automatically, execute the matching engine, or create blockchain trades. A trusted simulated-household wallet provisioning mechanism is the explicit prerequisite for an end-to-end 12-household Python snapshot. Do not call that end-to-end path completed until it is tested.
