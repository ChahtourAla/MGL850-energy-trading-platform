# B12 — Matching Engine Integration (PostgreSQL → Python → B05 → PostgreSQL)

**Starting point:** verified B11 commit `90efe4f` on branch `feature/nestjs-backend`.
**Implementation type:** additive backend operator CLI and one new Prisma metadata model. Existing `Match` Prisma model, Python matching engine, B05 validator, B09 snapshot metadata and B11 verifier are reused without replacement.
**Network safety:** B12 NEVER interacts with Hedera, creates/funds trades, generates wallets, or uses wallet private keys.

## What B12 implements

1. Read the **original B11 snapshot JSON file** imported for a specific UTC hour (this is the immutable source of matching profiles and energy quantities).
2. Validate its `energy-snapshot` schema (B05), and check that it exactly matches all energy rows and real wallet addresses in B09/B11 PostgreSQL; additionally verify the **original B09 SHA-256 import fingerprint** (including the original location, reputation, energy preferences, and prices). Never rebuild matching profiles from mutable user settings.
3. Create canonical `matching-input` using the shared schema and a versioned matching config.
4. Launch the **existing Python** `matching_engine.cli` with a timeout; never duplicate the matching algorithm in JavaScript.
5. Validate `matching-output` with B05's `assertMatchingOutputAgainstInput`, plus buyer energy-preference checks. Reject invalid IDs, forged wallet addresses, oversold energy, mismatched quantities/prices, invalid unmatched buyer lists.
6. Dry-run by default, writing only temporary JSON artifacts. Database commit requires both `--execute` **and** `B12_MATCH_IMPORT_CONFIRM=YES`.
7. Atomically store `Match` rows in the existing B04 `matches` table and one `MatchingRun` fingerprint metadata row for the hour. Exact repeats are read-only idempotent; different configs/results or historical match rows are rejected.
8. Persist a matching run even when no match is possible, so later re-execution cannot silently change a historical no-match outcome.

**Important:** This is an operator-run backend CLI (`apps/backend/scripts`), not a new REST endpoint. The authenticated trading REST API is planned for B17. All matching occurs off-chain.

### Source and compatibility caveat

This overlay was prepared from your earlier archived `MGL850-energy-trading-platform-main(2).zip` plus B05–B11 implementation overlays and the terminal-verified B11 results. It was **not** compiled or executed against your latest live Windows checkout. Before writing to PostgreSQL, check that your existing B04 Prisma `Match` model and `toMatchData()` mapper agree. The current B05 mapper already expects fields `id`, `timeSlot`, `buyerId`, `sellerId`, `quantityWh`, `unitPriceMicrousdPerKwh`, `totalAmountMicrousd`, `distanceKm`, `score`, `sellerEnergyType`, `algorithmVersion`, `status: SELECTED`.

## Step 1 — Preflight, working tree, and safe overlay extraction

PowerShell from the repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git branch --show-current
git log -1 --oneline
git status --short
pnpm exec prisma migrate status --config prisma7.config.ts

$patch = Join-Path $HOME 'Downloads\B12-matching-engine-integration.zip'
if (-not (Test-Path $patch)) { throw 'B12 overlay ZIP is missing' }
if (Test-Path 'apps\backend\scripts\b12-matching-pipeline.mjs') {
    throw 'B12 already exists. Inspect and reconcile before extraction.'
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

The overlay adds only:

```text
README-B12.md
apps/backend/scripts/b12-matching-core.mjs
apps/backend/scripts/b12-matching-core.test.mjs
apps/backend/scripts/b12-matching-pipeline.mjs
```

It does **not** overwrite previous code, data, environment files, DB tables, or migrations. Keep `.agents/`, `.claude/`, `.windsurf/` and `skills-lock.json` separate.

## Step 2 — Add ONE MatchingRun model to database/schema.prisma

Inspect the B04 Prisma schema first. `model Match` and `model EnergySnapshotImport` must already exist. Do NOT create a second `Match` model or replace the existing matches table. Append the following **new** model only if `MatchingRun` does not already exist:

```prisma
model MatchingRun {
  id                  String   @id @db.Uuid
  snapshotId          String   @map("snapshot_id") @db.Uuid
  timeSlot            DateTime @unique @map("time_slot") @db.Timestamptz(3)
  algorithmVersion    String   @map("algorithm_version") @db.VarChar(32)
  configSha256        String   @map("config_sha256") @db.Char(64)
  resultSha256        String   @map("result_sha256") @db.Char(64)
  matchCount          Int      @map("match_count")
  unmatchedBuyerCount Int      @map("unmatched_buyer_count")
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([snapshotId])
  @@map("matching_runs")
}
```

The standalone metadata table is needed for zero-match hours and conflict protection. The existing B04 `matches` table is still authoritative for the actual selected matches.

Generate a **draft migration** and inspect it before applying:

```powershell
pnpm exec prisma validate --config prisma7.config.ts
pnpm exec prisma migrate dev --config prisma7.config.ts --name matching_runs_b12 --create-only
```

Verify the new migration creates **only** `matching_runs` and its indexes. If Prisma proposes deleting or recreating unrelated tables, **stop**. Do NOT run `prisma migrate reset`, `db push --force-reset`, or edit historical migrations.

Apply the reviewed migration and regenerate the client:

```powershell
pnpm exec prisma migrate dev --config prisma7.config.ts
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm exec prisma generate --config prisma7.config.ts
```

No new npm packages and no Hedera account funding are required.

## Step 3 — Build and tests

```powershell
node --test apps/backend/scripts/b12-matching-core.test.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

Expected core test count: **23 passing B12 Node tests**. Existing **144 backend Vitest tests** should remain passing; B12 adds no NestJS Vitest suites. Build/typecheck/lint should also pass.

Locally the 23 Node tests passed and the original Python matching CLI was exercised with the repository's shared sample input. **These do not prove live PostgreSQL success**; that must be verified in your checkout below.

## Step 4 — Find the original B11 imported snapshot

Your successful B11 import reported this exact file:

```powershell
$snapshot = Join-Path $env:TEMP 'b11-energy-HNj6st\snapshots\energy_snapshot_2026-11-09T12.json'
if (-not (Test-Path $snapshot)) {
  throw "Cannot find B11's original imported snapshot. Do not fabricate or edit one: $snapshot"
}
```

If the OS temp directory was cleaned, B11 can regenerate a snapshot using the same source registry, config, UTC hour and options. **You must verify the regenerated file against the original B09 SHA-256 fingerprint before matching.** Do not change the occupied UTC hour or replace the saved data to make it fit.

The B11 snapshot is canonical and includes the original location, reputation and preference data needed for matching, which B09's `energy_records` table alone does not preserve.

## Step 5 — B12 dry run first (NO matching rows written)

```powershell
Push-Location apps/backend
try {
    node --env-file=../../.env scripts/b12-matching-pipeline.mjs `
        --snapshot $snapshot `
        --expected-users 12
}
finally { Pop-Location }
```

Expected shape (actual match count is NOT known in advance):

```text
B12 PLAN: snapshot=f6fcce06-ec80-5939-9473-cfea17eeb3b7 UTC hour=2026-11-09T12:00:00Z; buyers=5, sellers=7; DRY RUN
B12 ARTIFACTS: C:\...\Temp\b12-matching-...
PASS: Matching completed for 2026-11-09T12:00:00Z
B12 VALIDATED: <N> selected matches; <5-N> unmatched buyers; no overselling
B12 OUTPUT: C:\...\matching-output.json
B12 DRY RUN PASS: zero matching records written.
```

Do not assume 5 matches: actual eligibility depends on distance, available Wh, buyer max price, energy-type preference, and seller inventory.

The B12 temp folder contains canonical `matching-input.json` and `matching-output.json`. It contains EVM addresses but **no wallet secrets**; do not commit these generated payloads.

If Python cannot import the package, verify the Python environment used for B11 also has `pydantic` and `matching_engine` dependencies. Use `--python 'C:\path\to\python.exe'` to select your virtual environment. The CLI sets the repository Python source paths automatically.

## Step 6 — Execute B12 database commit (NO Hedera operations)

**Only after the dry run and migration succeeded**:

```powershell
$env:B12_MATCH_IMPORT_CONFIRM = 'YES'
Push-Location apps/backend
try {
    node --env-file=../../.env scripts/b12-matching-pipeline.mjs `
        --snapshot $snapshot `
        --expected-users 12 `
        --execute
}
finally {
    Pop-Location
    Remove-Item Env:\B12_MATCH_IMPORT_CONFIRM -ErrorAction SilentlyContinue
}
```

Expected first success:

```text
B12 VALIDATED: <N> selected matches; <5-N> unmatched buyers; no overselling
B12 PERSISTED: created=<N>; unchanged=0; unmatched=<5-N>
B12 PASS: B11 PostgreSQL -> Python matching -> B05 validation -> atomic PostgreSQL match persistence; NO Hedera transactions
```

A **verified NO-MATCH result** is also valid (N=0). Rerun the **same** command with the same snapshot and config; then expect `created=0; unchanged=<N>`. No trade or blockchain transaction is generated.

If the command exits with a database timeout/uncertain status, inspect `matching_runs` and `matches` for the selected hour before retrying. The script has no automatic retries. A modified config, result or legacy row for this UTC hour fails closed.

## Step 7 — Commit only after verification

```powershell
git status --short
git diff --check
git check-ignore -v .env

git add README-B12.md
git add apps/backend/scripts/b12-matching-core.mjs
git add apps/backend/scripts/b12-matching-core.test.mjs
git add apps/backend/scripts/b12-matching-pipeline.mjs
git add database/schema.prisma
git add database/migrations

git diff --cached --check
git diff --cached --stat
git commit -m 'feat(backend): validate and persist hourly Python matches'
git log -1 --oneline
git status --short
```

If the migration failed, do not commit or move to B13. Exclude `.env`, wallet exports, temp-generated snapshots, and unrelated tooling directories.

## B12 design limits

- B12 creates `SELECTED` matching records only. It does not create escrow trades, sign wallet transactions or spend HBAR.
- Match IDs are generated by Python from snapshot and pair parameters. Timestamp `createdAt` and CLI `executionTimeMs` are intentionally excluded from the stable result fingerprint. A changed business result is a conflict, not an update.
- `matching_runs` records only one immutable run per UTC hour. If the project later needs algorithm-version comparisons, add a separate explicit comparison feature rather than overwriting saved selections.
- A B12 repeat after B13/B14 changes a match status away from `SELECTED` intentionally fails closed to protect subsequent trade state.
- There is currently no new NestJS REST route; B17 will add authenticated public/internal trading APIs with proper authorization.
- Database schema assumptions rely on existing B04 `Match` Prisma model and B05 mapper and should be checked in your checkout.
