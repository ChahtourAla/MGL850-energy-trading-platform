# B16 — Energy Delivery and Oracle Integration (Hedera Testnet)

## Scope

This single package implements the existing Python delivery simulator integration, strict B12/B14/B15 and on-chain preflight, fresh SUCCESS delivery validation, immutable SHA-256 evidence commitment, verified ORACLE_ROLE, journaled ECDSA signing, encrypted recovery material, at-most-once RPC submission, receipt reconciliation, and idempotent Prisma Trade/DeliveryRecord completion.

**IMPORTANT:** On the deployed EnergyTradingEscrow, `confirmDelivery(uint256,uint256,bytes32)` emits `DeliveryConfirmed`, immediately sends escrowed TEUSD to seller, emits `TradeSettled`, and ends in `COMPLETED`. B16 is a **settlement** action, not an isolated delivery flag. No contract redeployment or buyer/escrow funding is performed. There is no physical meter attestation: this is **synthetic simulation**, not proof of real electricity transfer.

## Known verified B14 / B15 trade

- Match: `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`
- Hedera Testnet chain ID 296, on-chain trade ID 2
- 2188 Wh, 250232 base TEUSD units (0.250232 TEUSD)
- Delivery: `2026-11-11T03:00:00Z` through `2026-11-11T04:00:00Z` (November 10, 22:00–23:00 Toronto local time)
- Prior state: `AWAITING_DELIVERY` with 250232 TEUSD held by escrow

The `confirmDelivery` contract method has no internal timestamp guard; the B16 oracle adds a strict on-chain-window and recently-generated-evidence policy. Do not bypass those guards. If the window expires, use B17 expiration/refund handling rather than forging old/future evidence.

## Installation (once; safe now)

From repo root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
$zip = Join-Path $HOME 'Downloads\B16-unified-delivery-oracle.zip'
if (!(Test-Path $zip)) { throw 'B16 ZIP missing' }
if (Test-Path 'apps/backend/scripts/b16-oracle.mjs') { throw 'B16 already installed; stop rather than overwrite' }
Expand-Archive -LiteralPath $zip -DestinationPath (Get-Location).Path
node tools/install-b16-schema.mjs
if ($LASTEXITCODE -ne 0) { throw 'B16 Prisma schema patch failed' }
pnpm exec prisma validate --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Schema invalid; do not migrate' }
pnpm exec prisma migrate dev --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'B16 migration failed' }
pnpm exec prisma generate --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Prisma generate failed' }
node --test apps/backend/scripts/b16-oracle-core.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'B16 tests failed' }
node --check apps/backend/scripts/b16-oracle.mjs
if ($LASTEXITCODE -ne 0) { throw 'B16 syntax check failed' }
pnpm --filter @energy-trading/backend build
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
pnpm --filter @energy-trading/backend typecheck
if ($LASTEXITCODE -ne 0) { throw 'Backend types failed' }
pnpm --filter @energy-trading/backend test
if ($LASTEXITCODE -ne 0) { throw 'Backend regression tests failed' }
pnpm --filter @energy-trading/backend lint
if ($LASTEXITCODE -ne 0) { throw 'Backend lint failed' }
```

The schema installer only adds `B16OracleIntent` and the optional `Match.b16OracleIntent` relation; the provided Prisma migration creates its own journal and never edits B14's five operations. An already present B16 schema is left unchanged. If Prisma reports drift or another migration proposal, **stop and inspect**; never reset the DB.

## Read-only public preflight (safe before the delivery window)

The Oracle EVM address is derived from the locally loaded `HEDERA_ORACLE_PRIVATE_KEY` if present. For **read-only** preflight without private key, set `B16_ORACLE_PUBLIC_ADDRESS` to the known authorized oracle address (do not guess it). Oracle must own `ORACLE_ROLE` and have enough Testnet HBAR for eventual gas.

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
  if ($LASTEXITCODE -ne 0) { throw 'B16 preflight failed; no transaction sent' }
} finally { Pop-Location }
```

Expected: `B16 PREFLIGHT PASS` and `inDeliveryWindow: false` **before** November 11 03:00 UTC. It checks the five successful B14 receipts, matching funding event, B15 Trade, existing DeliveryRecord schema and state, authorized Oracle, and deployed contract. No database writes or signatures.

## Run the simulator safely now; generate real evidence only during the window

The `--action simulate` command has two intentionally different behaviors:

1. **Outside November 11, 03:00–04:00 UTC**, it runs the real Python delivery generator against isolated synthetic identifiers and a synthetic current window. The temporary result is validated and then deleted. The requested `--output b16-delivery-2.json` **does not get created**. This tests simulator integration without producing evidence that can be used for the real trade.
2. **Inside the real delivery window**, it generates a fresh `DeliveryRecord` for trade `2`, validates it against the on-chain delivery window and writes the actual `--output` file.

Execute from the repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
# Set B16_PYTHON only if the service uses a specific virtual environment:
# $env:B16_PYTHON = (Resolve-Path '.\.venv\Scripts\python.exe').Path
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action simulate --output 'b16-delivery-2.json'
  if ($LASTEXITCODE -ne 0) { throw 'B16 simulator test or real delivery evidence generation failed' }
} finally { Pop-Location }
```

Expected **before** the window: `B16 SIMULATOR DRY RUN PASS` and `B16 DRY RUN SAFE`. There will be no real delivery JSON at the requested path. A Python or dependency error is a separate environment problem and should be fixed without fabricating delivery timestamps.

Never use dry-run output (which is intentionally deleted) as oracle settlement evidence. The `--action execute` call below remains explicitly authorized and guarded by the *real* trade's delivery window and immutable evidence checks.

## Explicit on-chain settlement (Testnet, one transaction, only DURING the delivery window)

The exact consent applies to real on-chain state changes and DB sync. Signing uses `HEDERA_ORACLE_PRIVATE_KEY`; the encrypted journal uses the **existing** `B14_SIGNED_TX_KEY_B64`. Do not rotate either key during an unresolved transaction. Maximum gas fee 0.75 HBAR with at least 0.2 HBAR balance reserved. There is no auto-resubmission after relay uncertainty.

```powershell
$env:B16_SETTLEMENT_CONFIRM='I_AUTHORIZE_ONE_ORACLE_SETTLEMENT_ON_HEDERA_TESTNET'
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action execute --evidence 'b16-delivery-2.json'
  if ($LASTEXITCODE -ne 0) { throw 'B16 execution stopped: inspect journal; NEVER resubmit automatically' }
} finally {
  Pop-Location
  Remove-Item Env:\B16_SETTLEMENT_CONFIRM -ErrorAction SilentlyContinue
}
```

If the receipt is not available immediately, execution intentionally stops after the sole submission attempt. **Do not rerun `--execute` or resend a signed transaction after the relay accepted it.** Use `--action reconcile` repeatedly as a read-only check of the same tx hash (it only updates B16 journal state when evidence appears). For a confirmed receipt, it checks `DeliveryConfirmed`, `TradeSettled`, correct TEUSD Transfer, recorded evidence hash and on-chain `COMPLETED` state.

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action reconcile
  if ($LASTEXITCODE -ne 0) { throw 'B16 reconciliation not yet successful' }
} finally { Pop-Location }
```

After `B16 RECONCILED: ...->CONFIRMED`, synchronize your DB without sending a transaction (the first `--execute` call already performs this automatically if the receipt was available):

```powershell
$env:B16_DB_SYNC_CONFIRM='SYNC_CONFIRMED_B16_DELIVERY_ONLY'
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action sync
  if ($LASTEXITCODE -ne 0) { throw 'B16 DB sync failed; no blockchain resend' }
} finally { Pop-Location; Remove-Item Env:\B16_DB_SYNC_CONFIRM -ErrorAction SilentlyContinue }
```

Finally read-only verification:

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action verify
  if ($LASTEXITCODE -ne 0) { throw 'B16 final verification failed' }
} finally { Pop-Location }
```

Expected: `B16 VERIFY PASS: trade 2 COMPLETED; DeliveryConfirmed + TradeSettled + seller TEUSD Transfer; PostgreSQL Trade & DeliveryRecord consistent; no writes`.

## Local Git commit (NO PUSH)

Once installation, preflight and tests pass, the **implementation** can be committed locally. The **live on-chain settlement** must only be marked completed after verification inside/after the real delivery window.

```powershell
git add -- README-B16-UNIFIED.md tools/install-b16-schema.mjs database/schema.prisma database/migrations/20261110040000_b16_oracle_intents/migration.sql apps/backend/scripts/b16-oracle-core.mjs apps/backend/scripts/b16-oracle-core.test.mjs apps/backend/scripts/b16-oracle.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(backend): implement guarded simulated delivery and Hedera oracle settlement"
```

Do not stage `.env`, transaction keys, generated evidence, `.agents/`, `.claude/`, `.windsurf/`, or `skills-lock.json`. Keep the branch local until the rest of the milestones have been implemented, as agreed.
