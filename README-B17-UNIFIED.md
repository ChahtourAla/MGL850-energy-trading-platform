# B17 — Settlement Audit, Cancellation, Expiration, Refund and Recovery

**Hedera Testnet chain ID 296, one unified implementation.** Complete source package with an additive Prisma model/migration, pure safety tests, a guarded operator CLI, journaled signing/broadcast, on-chain receipt/event verification, separate DB sync, and read-only B16 successful-settlement audit.

**Important: existing trade #2 stays protected.** Its B16 oracle evidence and final seller settlement remain separate. **This package does not create or fund any new trade and does not execute a single on-chain transaction by default.** To exercise failure/refund paths without disrupting #2, first create an **independent funded test trade using B12–B15**, a different matched UUID and on-chain ID, and let *its own* delivery deadline pass. The B17 installer applies only its own migration; it never edits the B14 or B16 journal tables.

## Deployed contract truth (do not rename lifecycle transitions)

| Operation | Signer role | Required state | Additional precondition | Outcome | Funds moved |
| --- | --- | --- | --- | --- | --- |
| `CANCEL` (`cancelTrade`) | `OPERATOR_ROLE` | `CREATED` | Not yet funded | `CANCELLED` | **None** |
| `EXPIRE` (`expireTrade`) | `OPERATOR_ROLE` | `AWAITING_DELIVERY` | On-chain block time > deadline; B17 adds 60-second safety buffer, no unresolved B16 oracle | `EXPIRED` | **None** (escrow remains held) |
| `REFUND` (`refundTrade`) | `OPERATOR_ROLE` | `EXPIRED` | Prior B17 EXPIRE intent receipt confirmed and DB synchronized | `REFUNDED` | Escrow sends exact TEUSD to **buyer** |
| Successful settlement (`confirmDelivery`) | `ORACLE_ROLE` | `AWAITING_DELIVERY` | B16 validated fresh delivery evidence | `COMPLETED` | Escrow sends TEUSD to **seller** immediately |

The deployed Solidity contract **does not expose** a `failTrade` entry point. Its `FAILED` enum value exists but cannot be reached using the current public contract API. Don't fake it or fabricate failure events. In the current prototype, unsuccessful delivery is represented by `EXPIRED` followed by `REFUNDED`.

## Installation — once from repository root (no blockchain writes)

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
$patch = Join-Path $HOME 'Downloads\B17-unified-recovery.zip'
if (!(Test-Path $patch)) { throw 'B17 ZIP missing in Downloads' }
if (Test-Path 'apps/backend/scripts/b17-recovery.mjs') { throw 'B17 already installed; stop rather than overwrite' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
node tools/install-b17-schema.mjs
if ($LASTEXITCODE -ne 0) { throw 'B17 schema patch failed' }
pnpm exec prisma validate --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Schema invalid: STOP, do not migrate' }
pnpm exec prisma migrate dev --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Migration failed: never reset the database' }
pnpm exec prisma generate --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Prisma generation failed' }
```

Inspect `git diff -- database/schema.prisma` and the new migration before committing. Stop if Prisma asks to reset the database or reports drift. The schema patch is idempotent and only adds `B17OperatorIntent` and `Match.b17OperatorIntents`; it never touches B14 or B16 journal schema.

## Test suite — no chain transactions

```powershell
node --test apps/backend/scripts/b17-recovery-core.test.mjs tools/install-b17-schema.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'B17 tests failed' }
node --check apps/backend/scripts/b17-recovery.mjs
if ($LASTEXITCODE -ne 0) { throw 'B17 entrypoint syntax failed' }
pnpm --filter @energy-trading/contracts test
if ($LASTEXITCODE -ne 0) { throw 'Existing Hardhat contract tests failed' }
pnpm --filter @energy-trading/backend build
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
pnpm --filter @energy-trading/backend typecheck
if ($LASTEXITCODE -ne 0) { throw 'Backend typecheck failed' }
pnpm --filter @energy-trading/backend test
if ($LASTEXITCODE -ne 0) { throw 'Backend regression suite failed' }
pnpm --filter @energy-trading/backend lint
if ($LASTEXITCODE -ne 0) { throw 'Backend lint failed' }
```

The new JavaScript tests are pure, with mocked immutable receipt/event records. The existing Hardhat Solidity tests exercise the contract's cancel/expire/refund paths on a **local in-memory simulated chain**, not on Hedera Testnet.

## Safe read-only inspection of existing trade #2

No operator signing key is necessary for read-only inspection (the public operator address is pinned from the confirmed B14 CREATE_TRADE journal). `B14_SIGNED_TX_KEY_B64` is needed only to inspect/reconcile a previously signed B17 transaction.

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
  if ($LASTEXITCODE -ne 0) { throw 'B17 read-only inspection failed' }
} finally { Pop-Location }
```

Expected: `B17 INSPECT PASS`, status `AWAITING_DELIVERY` until B16 executes, and no B17 journal operations yet. Inspection does **not** modify the database or escrow. Once B16 fully settles, audit the proof with `--action verify --operation settlement`; this verifies `DeliveryConfirmed`, `TradeSettled`, and the exact TEUSD seller transfer, using the prior B16 journal. Before B16 executes, this settlement audit will *correctly* refuse.

## Independent test trade: cancellation / expiry / refund

Choose an **existing B12 match and B14/B15 funded trade other than #2**. Don't reuse a match ID because each match deterministically maps to one external trade ID. A funded trade supports `EXPIRE` and later `REFUND`, not `CANCEL`. A `CREATED` and *unfunded* trade supports `CANCEL`, not `EXPIRE`; because B15 only persists funded trades, B17 records the cancellation in its separate journal even if the Prisma `Trade` row does not exist.

First, inspect (always read-only):

```powershell
$testMatchId = '<DIFFERENT-B12-MATCH-UUID>'  # Replace with a real match, never trade #2
if ($testMatchId.Contains('<')) { throw 'Choose an isolated test match UUID first' }
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId
  if ($LASTEXITCODE -ne 0) { throw 'B17 test trade inspection failed' }
} finally { Pop-Location }
```

Select `EXPIRE` only when the on-chain delivery deadline +60 seconds has passed, and only when the trade remains funded with no conflicting B16 oracle intent. For a correct test trade:

```powershell
$operation = 'EXPIRE'  # Or 'CANCEL' if the test trade is CREATED and unfunded
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId --action plan --operation $operation
  if ($LASTEXITCODE -ne 0) { throw 'B17 preflight failed. Do not execute.' }
} finally { Pop-Location }
```

**Optional real TESTNET operator transaction** — *only for the isolated trade*, after reviewing the read-only plan. This costs HBAR and changes the on-chain trade state. `B17_ONCHAIN_CONFIRM` is not stored in the repository. The second confirmation for protected trade #2 is deliberately not included in these instructions.

```powershell
$env:B17_ONCHAIN_CONFIRM = "I_AUTHORIZE_B17_${operation}_ON_HEDERA_TESTNET"
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId --action execute --operation $operation
  if ($LASTEXITCODE -ne 0) { throw 'B17 submission may be uncertain; inspect journal, never blindly resubmit' }
} finally {
  Pop-Location
  Remove-Item Env:\B17_ONCHAIN_CONFIRM -ErrorAction SilentlyContinue
}
```

`execute` creates an immutable Prisma journal row, persists an **AES-256-GCM encrypted raw signed transaction** using your existing `B14_SIGNED_TX_KEY_B64` *before* transmission, then changes status to `SUBMITTED` in the database before making **one** `eth_sendRawTransaction` call. If the process crashes before relay, a `SIGNED` journal is safely resumeable only when the RPC nonce remains unchanged and the original hash is absent. If it reaches `SUBMITTED`, `NEEDS_RECONCILIATION`, `CONFIRMED`, or `REVERTED`, it will never transmit again. If relay status is uncertain, use **only** `reconcile` until the original hash can be resolved. Never replace keys or journal rows while unresolved.

Reconcile / sync / verify the exact existing transaction (separate commands; `execute` will also attempt these immediately after send):

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId --action reconcile --operation $operation
  if ($LASTEXITCODE -ne 0) { throw 'Reconcile failed: inspect, never resubmit' }
} finally { Pop-Location }

$env:B17_DB_SYNC_CONFIRM = 'SYNC_CONFIRMED_B17_TRADE_STATUS_ONLY'
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId --action sync --operation $operation
  if ($LASTEXITCODE -ne 0) { throw 'B17 DB sync failed: no second chain transaction' }
} finally { Pop-Location; Remove-Item Env:\B17_DB_SYNC_CONFIRM -ErrorAction SilentlyContinue }

Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b17-recovery.mjs --match-id $testMatchId --action verify --operation $operation
  if ($LASTEXITCODE -ne 0) { throw 'B17 final verification failed' }
} finally { Pop-Location }
```

Once `EXPIRE` is confirmed **and DB synced**, the same *isolated trade* becomes eligible for `REFUND`. Change `$operation = 'REFUND'` and repeat the **plan → explicit execute → reconcile → DB sync → verify** workflow with a **separate** transaction intent and new confirmation string. `expireTrade` alone never moves TEUSD. Refund verification checks the `TradeRefunded` event, a `Transfer` from escrow to the **buyer** of exactly the escrowed microTEUSD amount, and the on-chain `REFUNDED` state. Duplicate/refunded transactions are rejected. The older EXPIRE receipt remains verifiable after the refund.

## Git commit (only after your local checks; no push)

```powershell
git diff -- database/schema.prisma
git add -- README-B17-UNIFIED.md tools/install-b17-schema.mjs tools/install-b17-schema.test.mjs
git add -- apps/backend/scripts/b17-recovery.mjs apps/backend/scripts/b17-recovery-core.mjs apps/backend/scripts/b17-recovery-core.test.mjs
git add -- database/schema.prisma database/migrations/20261110061000_b17_operator_intents/migration.sql
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
git commit -m 'feat(backend): implement safe Hedera escrow expiration and refund recovery'
git log -4 --oneline
git status --short --untracked-files=no
```

Do not add `.env`, generated secrets, encrypted live evidence files, `.agents/`, `.claude/`, `.windsurf/`, or unrelated skill metadata. Keep the branch local until B18/B19 are validated.

## Scope and limitations

1. The **implementation** can be committed after schema, tests, preflight and contract tests pass. **Live operator transfers** are *not* complete until independently exercised on isolated Testnet trades; this package does not claim they have already happened.
2. The real `confirmDelivery` contract method instantly pays the seller. The operator may not expire a trade with an outstanding B16 oracle intent; prioritize resolving that B16 hash first.
3. `CANCEL` of an unfunded `CREATED` trade has no buyer refund (no funds were escrowed). `EXPIRE` records failure to deliver but must be followed by `REFUND` to return the buyer's funds.
4. This prototype does not guarantee actual electrical delivery. The evidence is simulated.
5. The package is a guarded operations CLI and database journal, **not yet a production API endpoint or background worker**. Those are B18/B19 integration tasks.
