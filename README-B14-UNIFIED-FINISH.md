# B14 — ONE PACKAGE: Finish buyer approval, trade creation and escrow funding

This package replaces the need for separate B6-B / B6-C / B7 / B8 patch ZIPs. **Do not reinstall or replace any previous B14 files**. It adds only the four new script files and this guide.

## Exact state expected at installation
- Branch `feature/nestjs-backend`, latest committed B13 `3fa4c89` (B14 scripts not yet committed)
- B12 match `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`
- `FUND_BUYER_HBAR = CONFIRMED`, tx `0xebde77004e98b296dab6be9826136fdc25e832799b7c5047ef8c719f5dc18750`
- `MINT_TEUSD = CONFIRMED`, tx `0xb1aba96c4ab35f27f04137590201b3aeccf790f1201d4173f25546fd192a9800`
- 0.250232 TEUSD and 0.2 HBAR in the B07 buyer wallet
- AES-256-GCM keys in the ignored environment files, no new key generation
- NestJS backend built (for generated `dist/generated/prisma/client.js`)

## Copy the ZIP contents to the REPOSITORY ROOT

From PowerShell at the repo root (do not overwrite a previous unified run):

```powershell
$patch=Join-Path $HOME 'Downloads\B14-unified-finish.zip'
if (!(Test-Path $patch)) { throw 'ZIP not in Downloads' }
if (Test-Path 'apps/backend/scripts/b14-complete.mjs') { throw 'Unified package already installed' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

## One test batch

```powershell
node --test apps/backend/scripts/b14-final-core.test.mjs
node --check apps/backend/scripts/b14-finish.mjs
node --check apps/backend/scripts/b14-complete.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

Expected: 66 standalone safety tests; previously the backend had 148 tests. These tests passed in the local reconstructed scripts; **full NestJS integration and live Hedera interactions require your checkout.**

## Preview (read-only, no signature, no journal change)

```powershell
$deliveryStart=(Get-Date).ToUniversalTime().AddHours(24).ToString('yyyy-MM-ddTHH:00:00Z')
Write-Host "FIXED B14 DELIVERY START: $deliveryStart"
Push-Location apps/backend
try {
 node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-complete.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --delivery-start $deliveryStart
 if($LASTEXITCODE -ne 0) { throw 'B14 preview failed' }
} finally { Pop-Location }
```

Store the displayed **fixed UTC delivery start** safely. If interrupted, use THE SAME value when resuming; do not regenerate a different date for an existing `CREATE_TRADE` intent. The start must be 10 min to 30 days in the future when first staged; 24h gives room for the workflow.

## All remaining actions in ONE execution

***This sends up to THREE separate fee-bearing transactions on Hedera Testnet:*** buyer `approve(escrow,250232)`, operator `createTrade(...)`, and operator `fundTrade(onChainId)`. They are not atomic across the three operations. Any problem stops the workflow with the journal retaining the exact recovery data; already-sent transactions are **never resubmitted automatically**.

```powershell
$env:B14_FINISH_ALL_CONFIRM='EXECUTE_EXACT_APPROVAL_CREATE_AND_FUND_ON_HEDERA_TESTNET'
Push-Location apps/backend
try {
 node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-complete.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --delivery-start $deliveryStart --execute
 if($LASTEXITCODE -ne 0) { throw 'B14 stopped: inspect journal, do not retry a SUBMIT command' }
} finally {
 Pop-Location
 Remove-Item Env:\B14_FINISH_ALL_CONFIRM -ErrorAction SilentlyContinue
}
```

The runner checks each stored status, stages at most one immutable intent per match and operation, seals the existing transaction and persists encrypted bytes, claims SUBMITTED before broadcasting, and then runs read-only receipt reconciliation. A timeout or an uncertain result stops the workflow. A subsequent invocation can resume from the PostgreSQL state, using the **same delivery start** and encryption key, but never replaces or repeats a `SUBMITTED` transaction.

## Final read-only verification (no new transactions)

```powershell
Push-Location apps/backend
try {
 node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-complete.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --delivery-start $deliveryStart --verify
 if($LASTEXITCODE -ne 0) { throw 'B14 final verification failed' }
} finally { Pop-Location }
```

This verifies three final journal statuses plus on-chain escrow state, and checks earlier HBAR/mint receipts.

## Manual recovery and inspection

Use the existing B14 journal checker:

```powershell
Push-Location apps/backend
try {
 node --env-file=../../.env scripts/b14-intent-journal-check.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
} finally { Pop-Location }
```

For a missing receipt or `NEEDS_RECONCILIATION`, do NOT run an RPC broadcast manually. Execute the existing exact-hash `--reconcile` CLI with step and fixed delivery start; example:

```powershell
$env:B14_FINAL_CONFIRM='B14_RECONCILE_ONLY'
Push-Location apps/backend
try {
 node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-finish.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --step APPROVE_ESCROW --action RECONCILE
} finally { Pop-Location; Remove-Item Env:\B14_FINAL_CONFIRM -ErrorAction SilentlyContinue }
```

For `CREATE_TRADE` supply `--delivery-start $deliveryStart`. For `FUND_TRADE`, no delivery-start option. Only use reconciliation for the operation already signed/submitted.

## End-of-milestone success criteria

The journal should show FIVE `CONFIRMED` rows: `FUND_BUYER_HBAR`, `MINT_TEUSD`, `APPROVE_ESCROW`, `CREATE_TRADE`, `FUND_TRADE`.

On-chain:
- `getOnChainTradeId(externalTradeId)` is a nonzero integer
- Stored B12 buyer, seller, quantity, price and one-hour delivery window match the Solidity `Trade`
- `getTrade(onChainTradeId).status = AWAITING_DELIVERY`
- Escrow holds the matched TEUSD payment; buyer's balance decreased by that amount
- `TradeFunded` and TEUSD `Transfer(buyer, escrow, 250232)` each appear in the confirmed funding receipt

No new Prisma migrations or contract deployments are required in this package. The **five intent records** link the match to the confirmed on-chain operations. This package does not fabricate a separate `Trade` row in the existing Prisma `trade` table, because that table's current exact required schema was not available in the source snapshot; that mapping should be verified separately before claiming full trade-table synchronization.

The `.env` files, encrypted signed transactions and all private keys are private; never commit or paste them.

## Git commit after all checks pass

Only stage relevant B14 files + schema/migration from Phase B1, not arbitrary untracked agent folders or `.env` secrets. Inspect `git status --short`, `git diff --check`, `git diff --cached --stat` first. The final commit could be `feat(backend): complete Hedera Testnet escrow lifecycle`.
