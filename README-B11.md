# B11 — Full Python Energy Generation Pipeline

**Base:** B10 commit `1bd1551`, 144 passing NestJS/Vitest tests, 12 real Hedera Testnet wallets linked to B08 SIMULATED users. **B11 adds orchestration only:** no new Prisma migration, REST endpoint, smart contract, npm package, or Hedera transaction. B09 remains authoritative for idempotent hourly storage.

## Safety and correctness

1. Run the existing B09 **trusted DB exporter** on your **original un-enriched** B08 `user-registry.json`. It refuses missing wallets or changed UUID/email identity; it never generates addresses.
2. Validate wallet-ready registry with Python (`validate-users --require-wallets`) **and** B05 Node schema validator.
3. Run the **existing Python `generate-snapshot` CLI** for one **explicit UTC full hour** with the real B07 wallet identifiers. The default marks the first 4 alphabetically sorted UUIDs consumption-only so the scenario has buyers; the remaining users may be buyers or sellers according to the model/time slot.
4. Validate the generated snapshot with B05 and check that **every record corresponds to one source household, same UTC hour, and the wallet address from the exporter**.
5. **Dry run by default**: generation + validation, zero new PostgreSQL records, zero blockchain transactions. Any execution must include `--execute` **and** `B11_IMPORT_CONFIRM=YES`, plus the existing B08/B09 internal import API key. This is an opt-in database write, NOT a Testnet spend.
6. Execute a **single** POST to B09 `/internal/energy/import`. B09 rejects a different snapshot in an occupied UTC hour (`409`) and accepts an identical retry (`created=0, unchanged=12`). There are no automatic HTTP retries.
7. Read back B09 `energy_snapshot_imports` metadata, all `energy_records`, each bigint Wh/price value and wallet address from PostgreSQL. A separate read-only verifier supports reconciliation if the API response was lost.
8. Keep all run artifacts in a **new, uniquely named folder** under the OS temp directory (or `--artifact-dir`), including the wallet-enriched registry and generated snapshot. Do not commit those artifacts. If a request times out, verify the *same exact snapshot file* first; do not change the source/config/UTC hour and try again blindly.

The energy data is **simulated**, not physical smart-meter readings. An energy snapshot import does not fund a Hedera account or trigger a trade.

## 1. Extract the B11 overlay (PowerShell)

From repo root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git log -1 --oneline
git status --short

$patch = Join-Path $HOME 'Downloads\B11-full-python-energy-pipeline.zip'
if (-not (Test-Path $patch)) { throw 'B11 ZIP missing; download it first' }
if (Test-Path 'apps/backend/scripts/b11-energy-pipeline.mjs') {
    throw 'B11 exists already. Inspect before overwriting.'
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

New files:

```text
README-B11.md
apps/backend/scripts/b11-pipeline-core.mjs
apps/backend/scripts/b11-pipeline-core.test.mjs
apps/backend/scripts/b11-energy-pipeline.mjs
apps/backend/scripts/b11-verify.mjs
```

There are **no changes to existing application code**. Keep `.agents/`, `.claude/`, `.windsurf/` and `skills-lock.json` separate, as in B01–B10.

## 2. Prerequisites

- PostgreSQL is running and all B09 migrations are applied. B08 source registry still exists at `$env:TEMP\b08-generated-users.json`.
- The B10 `READY=12`, `PENDING=0` onboarding is already complete.
- You retained `DATABASE_URL` and `INTERNAL_IMPORT_API_KEY` in the ignored root `.env`. The backend runs at `http://127.0.0.1:3001` by default.
- **Keep wallet creation disabled** in `.env`: `WALLET_PROVISIONING_ENABLED=false`, `SIMULATION_WALLET_ONBOARDING_ENABLED=false`.
- Node 22+ and Python generator environment with `pydantic[email]` installed. The shared Python package already declares this optional extra. If Python uses another interpreter, supply `--python` with the path to the correct Python executable.
- Run the NestJS build first: B05 contract validator and B09 wallet exporter require `apps/backend/dist/` and generated Prisma client.

```powershell
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
python -c "import pydantic, email_validator; print('Python ready')"
```

## 3. Run the 26 new B11 tests (no DB or Hedera required)

```powershell
node --test apps/backend/scripts/b11-pipeline-core.test.mjs

# Existing 144 tests must still pass.
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

**Targets:** 26 B11 standalone Node tests, plus the existing 144 backend Vitest tests. B11 has no new NestJS tests, so the full Vitest count **remains 144** (not 170). These tests were executed here on Node 22.16 and passed. Run them again in your checkout.

## 4. Dry run: full Python generation with real wallet identities (no insert)

Run from the repo root (one terminal; PostgreSQL must be running):

```powershell
$source = Join-Path $env:TEMP 'b08-generated-users.json'
if (-not (Test-Path $source)) { throw 'Original B08 registry is missing' }

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b11-energy-pipeline.mjs `
    --registry $source `
    --time-slot '2026-11-09T12:00:00Z' `
    --expected-users 12 `
    --consumption-only-count 4
}
finally { Pop-Location }
```

Expected messages (actual role counts and snapshot UUID depend on the real data):

```text
B11 ARTIFACTS: ...\b11-energy-...
B11 PLAN: 12 existing households, hour 2026-11-09T12:00:00Z; 4 deterministic consumption-only; DRY RUN
B09 PASS: exported 12 wallet-ready households to ...
PASS: registry contains 12 valid users
B05 PASS: user-registry is valid
PASS: generated snapshot for 2026-11-09T12:00:00Z
Users: 12
B05 PASS: energy-snapshot is valid
B11 GENERATED: 12 records; SELLER=..., BUYER=..., NEUTRAL=...
B11 SNAPSHOT: ...\snapshots\energy_snapshot_2026-11-09T12.json
B11 DRY RUN PASS: no energy records imported. ...
```

- Set `--consumption-only-count` to `0–11`. **Keep this value unchanged when repeating the same hour** or B09 will reject the different snapshot.
- Run a midday hour (`12:00Z` in the example) if you need sellers and buyers for B12. Time is **UTC**, not Montréal local time.
- `--max-users 12` and `--expected-users 12` are safety defaults. A partial registry is rejected. B09's import cap is 200.
- The script auto-selects a unique temporary artifact directory, so it does not overwrite previous generated outputs. You can specify `--artifact-dir 'C:\safe\b11-artifacts'` to retain all runs in a chosen folder.
- This preview **does connect to PostgreSQL** to retrieve the trusted wallet mapping, but it **does not write** `energy_records`.

## 5. Execute real PostgreSQL import (NO HBAR spent)

Start or restart NestJS in Terminal 1:

```powershell
pnpm --filter @energy-trading/backend start:dev
```

From Terminal 2 (repo root), explicitly authorize the import and use the **same slot, config and consumption-only count**:

```powershell
$source = Join-Path $env:TEMP 'b08-generated-users.json'
$env:B11_IMPORT_CONFIRM = 'YES'

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b11-energy-pipeline.mjs `
    --registry $source `
    --time-slot '2026-11-09T12:00:00Z' `
    --expected-users 12 `
    --consumption-only-count 4 `
    --execute
}
finally {
  Pop-Location
  Remove-Item Env:\B11_IMPORT_CONFIRM -ErrorAction SilentlyContinue
}
```

Expected first successful import:

```text
B11 IMPORTED: created=12; unchanged=0; snapshot=<UUID>
B11 VERIFIED: 12 exact energy records persisted in PostgreSQL ...
B11 PASS: complete Python -> B05 -> B09 -> PostgreSQL pipeline verified
```

Run **the exact same command again** with the same registry, config, time slot and count. This should report:

```text
B11 IMPORTED: created=0; unchanged=12; snapshot=<same UUID>
B11 VERIFIED: 12 exact energy records persisted in PostgreSQL ...
```

Do not use `--overwrite` on the generator. The pipeline instead creates a unique artifact directory for each attempt. Never discard or modify historical records to force a retry.

## 6. Recover from a lost response or network outage

The script prints `B11 SNAPSHOT: <path>`. Use **that exact saved file**, without sending another HTTP import:

```powershell
$snapshot = 'C:\Users\...\AppData\Local\Temp\b11-energy-...\snapshots\energy_snapshot_2026-11-09T12.json'

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b11-verify.mjs $snapshot
}
finally { Pop-Location }
```

- **PASS:** the database already contains the exact snapshot; no re-import needed.
- **FAIL: missing metadata:** the request may never have been committed, but do not assume that until checking database state and server logs. You can later re-run the *same deterministic inputs*; B09 prevents conflicts and duplicate records.
- **HTTP 409:** an existing snapshot differs at that UTC hour or ID. Investigate its metadata and the original inputs. Do not overwrite the previous snapshot or modify its hash.
- The generated files contain public EVM/Hedera wallet identifiers, not private keys. Treat them as project artifacts; avoid indiscriminate publishing.

## 7. Commit B11

From repo root, after dry-run, import, verification and duplicate-import check:

```powershell
git status --short
git diff --check
git check-ignore -v .env

git add README-B11.md
git add apps/backend/scripts/b11-pipeline-core.mjs
git add apps/backend/scripts/b11-pipeline-core.test.mjs
git add apps/backend/scripts/b11-energy-pipeline.mjs
git add apps/backend/scripts/b11-verify.mjs

git diff --cached --check
git diff --cached --stat
git commit -m 'feat(backend): orchestrate verified Python hourly energy generation'
git log -1 --oneline
git status --short
```

Do not commit the untracked tooling folders or `.env`. You do not need `pnpm install`, Prisma generate, or new migrations for B11.

## Next: B12 Matching Engine Integration

Once one hour shows both SELLER and BUYER positions, use its persisted `energy_records` to build a matching input for the existing Python matcher, validate its output against the source input via B05, and store accepted matches in PostgreSQL. Do not create or fund any smart contract trade until B13/B14.
