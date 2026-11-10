# B19 — Final Cross-Layer Validation & Release Gate

## What B19 actually proves

B19 adds **read-only** independent cross-layer auditing for B12 matching, B07 EVM wallet ownership, B14 five confirmed funding receipts, B15 Prisma `Trade`, Hedera Testnet chain 296, B16 delivery/settlement journal, B17 expiration/refund journal, and the B18 API's established security boundary. It **does not** deploy contracts, mint funds, create new trades, generate live settlement evidence, sign, broadcast, reset PostgreSQL, alter Prisma schema, or attempt a refund. There is no migration.

The audit fails closed if it finds a mismatched chain, wallets, trade amount/identity, different on-chain and database states, a failed/missing funding receipt, unresolved oracle/operator intent (`PLANNED`, `SIGNED`, `SUBMITTED` or `NEEDS_RECONCILIATION`), or an invalid final settlement/refund journal. A success on an `AWAITING_DELIVERY` trade means **funding and read-side integration are consistent**, **not** that energy delivery or seller settlement has occurred.

For terminal states it checks the exact seller/recipient ERC-20 `Transfer` and `TradeSettled` or `TradeRefunded` receipt; when relevant it checks confirmed and synchronized journal status. `EXPIRED` is reported separately as `EXPIRED_REFUND_PENDING`.

The package files are:

- `apps/backend/scripts/b19-audit-core.mjs` — pure cross-layer assertions.
- `apps/backend/scripts/b19-audit-core.test.mjs` — 74 offline invariant/safety tests, including all state categories.
- `apps/backend/scripts/b19-audit.mjs` — read-only real PostgreSQL and Hedera RPC audit.
- `tools/b19-run-tests.ps1` — comprehensive local regressions, hardhat, NestJS and Python simulator checks, no live writes.
- `README-B19-UNIFIED.md` — instructions and limitations.

## Install (Windows PowerShell; repository root)

Download `B19-unified-final-validation.zip` to `$HOME\Downloads`, then:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
$zip = Join-Path $HOME 'Downloads\B19-unified-final-validation.zip'
if (-not (Test-Path $zip)) { throw 'B19 ZIP missing' }
if (Test-Path 'apps/backend/scripts/b19-audit.mjs') { throw 'B19 already installed. Review before overwriting.' }
Expand-Archive -LiteralPath $zip -DestinationPath (Get-Location).Path
node --test apps/backend/scripts/b19-audit-core.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'B19 new unit tests failed' }
```

**Important**: No `.env` or private keys are included in this ZIP. Don't use `git add .` (the repo contains unrelated untracked `.agents/`, `.claude/`, `.windsurf/` and `skills-lock.json`).

## Phase A — Comprehensive local tests (no Hedera writes)

```powershell
.\tools\b19-run-tests.ps1
```

This runs B13–B19 node tests, prior installer tests, an isolated Python delivery smoke, 68 Hardhat contract tests on a *local test network*, Prisma schema verification, NestJS build, typecheck, Vitest/e2e and lint. It may create test/build caches and outputs, but **does not invoke B14/B16/B17 state-changing CLI actions** or overwrite the funded Testnet trade. The actual test totals may increase as more test files are present.

If a command fails, stop and inspect its output before continuing. Do not reset the database to fix migrations. Do not execute or retry a blockchain transaction.

## Phase B — Live PostgreSQL + Hedera read-only audit

Only if Phase A passes, from the same repo root:

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b19-audit.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
  if ($LASTEXITCODE -ne 0) { throw 'B19 cross-layer read-only audit failed' }
} finally { Pop-Location }
```

While trade #2 remains funded and awaiting delivery, success includes:

```text
B19 CROSS-LAYER AUDIT PASS: {
  "category": "FUNDED_PENDING_DELIVERY",
  "chainId": 296,
  "onChainTradeId": "2",
  "b14Confirmed": 5,
  "chainStatus": "AWAITING_DELIVERY",
  "statusAligned": true,
  "blockchainWriteRequested": false,
  "databaseWriteRequested": false
}
B19 READ ONLY: no signing, network broadcast, database write, secret output, or settlement
```

The report is sanitized and omits private keys, RPC connection strings, signed raw transactions, encrypted journal fields, and delivery evidence payloads. If an intent is unresolved, stop and reconcile **the existing transaction hash only** via the relevant B16/B17 safe workflow. Never launch an additional broadcast automatically.

## Phase C — HTTP API smoke

B18 authenticated NestJS HTTP test already passed for trade #2: JWT `401`, internal key `403`, authorized workflow read, Decimal2 serialization, five B14 history entries, and **read-only** oracle preflight. Repeat the *previously successful* B18 HTTP smoke-test block from this conversation after installing B19; no new HTTP endpoints are added by this package. The full NestJS Vitest suite already tests JWT participant routing and 404 ownership isolation with mocked records, but a live participant login for simulated trade #2 has **not** been shown. The internal key must remain out of logs/browser apps; the `POST /preflight` route cannot authorize execution.

## Uncompleted real-world acceptance gates

1. **Real B16 settlement on trade #2 is pending.** The source window is **2026-11-11 03:00–04:00 UTC** (Nov 10, 2026, 10–11 PM in Montréal). No genuine meter delivery proof has yet been independently established. The current isolated Python simulator is explicitly *not* authorization to pay the seller. Do not simulate evidence to fabricate real delivery.
2. **A real expiration and TEUSD refund is not yet demonstrated** on a separately created, expired test trade. The Hardhat tests demonstrate those contract transitions locally, not an actual Testnet refund. Never use trade #2 for this scenario.
3. **Live participant JWT access** to simulated trade records needs a safely provisioned test user who actually belongs to that match; the internal diagnostic read is not a substitute for that.
4. **Production write-enabled HTTP APIs** are deliberately excluded from B18: only B14–B17 audited CLI workflows may sign and transmit. A separately scoped and reviewed worker would be needed for production REST-triggered settlements.

Therefore, Phase A + Phase B + B18 HTTP smoke prove a substantial technical release gate, **not** complete live end-to-end settlement/refund or production readiness. Do not claim the user received energy or the seller received payment before independent verification of actual on-chain events, token movement, and database synchronization.

## Local commit only (after Phase A/B and HTTP pass)

```powershell
git add -- apps/backend/scripts/b19-audit-core.mjs apps/backend/scripts/b19-audit-core.test.mjs apps/backend/scripts/b19-audit.mjs tools/b19-run-tests.ps1 README-B19-UNIFIED.md
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged B19 diff invalid' }
git diff --cached --stat
git diff --cached --name-only
git commit -m 'test(integration): add safe B19 cross-layer audit and release checks'
git status --short
```

Do not push before reviewing outstanding B16/B17 live settlement/refund acceptance, whether complete production write API execution is desired, secret scanning, tracked/untracked files, and the final branch diff. No broad `git add .` or `git push` is run by B19.
