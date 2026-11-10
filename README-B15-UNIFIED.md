# B15 — One complete implementation: On-chain payment → Prisma Trade synchronization

## What B15 changes

B15 takes the already-confirmed **B14 Hedera Testnet trade** and creates or safely updates the existing Prisma `Trade` row **once**. It does NOT sign, broadcast, mint, approve, or fund anything. The original B14 journal remains the immutable record of the five transactions.

Four additive files:

- `apps/backend/scripts/b15-trade-sync-core.mjs` — reusable pure validation, Prisma-model adaptation and idempotency rules
- `apps/backend/scripts/b15-trade-sync-core.test.mjs` — 155 deterministic safety tests
- `apps/backend/scripts/b15-trade-sync.mjs` — live on-chain read-only verification, preview, guarded PostgreSQL projection and read-only final verification
- `README-B15-UNIFIED.md` — this guide

**No migration is bundled**: the existing `Trade` model/table is reused. The script parses your *actual* `database/schema.prisma` and refuses to insert a partially mapped or unsupported row. This is intentional because the B14 source snapshot did not contain a copy of your team's actual `Trade` definition. In particular, the model must expose a unique `matchId`, `onChainTradeId`, `status`, buyer/seller IDs, amount/price/quantity, deliveryStart/deadline and contractAddress. If the model does not, the preview aborts without writes; do not bypass it or invent schema fields.

## Exact committed B14 reference

- Branch `feature/nestjs-backend`; current commits `ee0556f` and `fc2bf80`
- Match ID: `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`
- External trade ID: `0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07`
- Hedera Testnet chain ID `296`, on-chain trade ID `2`
- On-chain status: `AWAITING_DELIVERY` (2)
- Matched energy 2188 Wh, unit price 114366 micro-USD/kWh, escrow payment 250232 TEUSD units = 0.250232 TEUSD
- B14 database journal: 5 `CONFIRMED` transactions and receipt hashes; they must remain immutable.

## Install once at repo root (Windows PowerShell)

Download `B15-unified-trade-sync.zip` into Downloads and execute:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
$patch = Join-Path $HOME 'Downloads\B15-unified-trade-sync.zip'
if (-not (Test-Path $patch)) { throw 'B15 ZIP missing' }
if (Test-Path 'apps/backend/scripts/b15-trade-sync.mjs') { throw 'B15 already installed; do not overwrite' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

## Run tests and NestJS regression checks

```powershell
node --test apps/backend/scripts/b15-trade-sync-core.test.mjs
node --check apps/backend/scripts/b15-trade-sync.mjs
node --check apps/backend/scripts/b15-trade-sync-core.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

Expected: **155 new core tests** pass. The backend test suite previously had **148 tests**. New tests have been run locally against the isolated B15 core, not against your live PostgreSQL/Hedera instance. Full backend and live checks must succeed in your checkout.

## Run B15 complete lifecycle (same package, no second download)

**Preview (read-only):**

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b15-trade-sync.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
  if ($LASTEXITCODE -ne 0) { throw 'B15 preview failed; DO NOT sync' }
} finally { Pop-Location }
```

The preview checks:

1. B12 committed selected match, matching run, energy source, and existing B07 buyer/seller wallet addresses.
2. All five journal operations, signer and target addresses, immutable IDs and confirmed timestamps.
3. All five successful Hedera receipts, transaction source/destination/nonce, exact EVM calldata and event signatures (`Transfer`, `Approval`, `TradeCreated`, `TradeFunded`).
4. Trade `2`: canonical ID, buyer, seller, energy, price, calculated payment and one-hour UTC window; state `AWAITING_DELIVERY`.
5. Buyer 0 TEUSD / 0 remaining allowance, and escrow holding at least 250232 TEUSD units.
6. Existing PostgreSQL `Trade` row, schema compatibility, and whether action is `CREATE`, `UPDATE` or `UNCHANGED`.

**Sync PostgreSQL (the only write, requires exact authorization):**

```powershell
$env:B15_SYNC_CONFIRM = 'SYNC_VERIFIED_B14_TRADE_TO_POSTGRES_ONLY'
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b15-trade-sync.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --sync
  if ($LASTEXITCODE -ne 0) { throw 'B15 database sync failed; inspect before retrying' }
} finally {
  Pop-Location
  Remove-Item Env:\B15_SYNC_CONFIRM -ErrorAction SilentlyContinue
}
```

This takes a PostgreSQL advisory lock on the match, verifies the chain and B14 receipts again inside the transaction, and creates the `Trade` row or promotes a consistent `CREATED`/`FUNDED` row to `AWAITING_DELIVERY`. It will never overwrite a mismatched trade, overwrite an on-chain ID, or downgrade a delivered/settled/refunded trade. Re-running a successful sync prints `UNCHANGED`.

**Final verification (read-only):**

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b15-trade-sync.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --verify
  if ($LASTEXITCODE -ne 0) { throw 'B15 final verification failed' }
} finally { Pop-Location }
```

Expected: `B15 VERIFY PASS: on-chain trade, all five B14 receipts/events and Prisma Trade are consistent; no writes`.

## Safety rules and follow-up

- **Never** re-run B14 `--execute`, `--submit`, any mint or any escrow funding operation. B15 is DB-only.
- B15 intentionally **does not change** the on-chain `AWAITING_DELIVERY` state or release funds; delivery and settlement are later milestones.
- B15 does not add public endpoints; the NestJS trade API belongs to B18.
- If the preview says a `Trade` field is missing/required, stop and share the exact `model Trade` from `database/schema.prisma` (only that model, no `.env`); the package will not guess missing migration changes.
- The B14 transaction journal already has exact hashes for all five operations. B15 copies them into `Trade` only where matching compatible columns exist; it does not create additional or fabricated blockchain events.
- No new encryption keys, no secrets in source, and no additional Hedera gas fees.

## Commit locally only after `--verify` succeeds

```powershell
git status --short
git diff --check
git add -- README-B15-UNIFIED.md apps/backend/scripts/b15-trade-sync.mjs apps/backend/scripts/b15-trade-sync-core.mjs apps/backend/scripts/b15-trade-sync-core.test.mjs
git diff --cached --check
git diff --cached --stat
git commit -m 'feat(backend): sync confirmed Hedera escrow trades to Prisma'
git log -3 --oneline
```

Do not push yet. Keep `feature/nestjs-backend` local until subsequent milestones have been tested and committed; keep private backups since local commits are not a remote backup.
