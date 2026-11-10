# B14 — Trade Creation & Funding, Phase A: Verified Read-Only Preflight

**Base:** B13 commit `3fa4c89` on `feature/nestjs-backend` (148 NestJS tests + 29 B13 Node tests), and B12's 1 persisted selected matching result for `2026-11-09T12:00:00Z`.

**Status:** This is the **first** B14 integration increment, NOT a complete B14 implementation. No SQL schema change, credentials, NestJS module, contract writes, TEUSD minting, approvals, fundTrade calls, or new blockchain transactions are included. Phase B will require durable, idempotent transaction state tracking and the actual buyer/role signing review before sending any Testnet transactions. Never mark B14 complete on the basis of this preflight alone.

## Scope

The read-only preflight queries the committed B12 `MatchingRun`, `Match`, B11 `EnergyRecord`, B07 `Wallet`, `User` and optional existing `Trade` rows, rechecks buyer demand, seller inventory, profile price and energy type, and calculates the Solidity exact integer amount: `quantityWh * unitPriceMicrousdPerKwh / 1000`. A single match is selected by exact UUID or the only match in the selected hour.

It derives a stable externalTradeId from the Hedera Testnet chain ID (296), canonical escrow address, and match UUID. It reads the B13 deployment and checks token decimals, escrow status, whether the external ID has already been used on-chain, buyer TEUSD balance, and ERC-20 `allowance(buyer, escrow)`. When supplied an explicit public operator address it also checks OPERATOR_ROLE. All read outputs contain **only public wallet addresses** and decimal token quantities, never private keys.

The `--delivery-start` timestamp is **a future simulated delivery window**, separate from the historical hourly energy snapshot. This is an intentional prototype exercise, not proof that electricity can be traded for that historical hour. For a realistic workflow, generate future hourly energy snapshots with B11/B12. The delivery deadline is precisely one hour after delivery start, which must be 10 minutes to 30 days ahead of the current system UTC time.

**Critical contract behavior:** `EnergyTradingEscrow.fundTrade()` is callable by OPERATOR_ROLE, but transfers TEUSD *from the buyer*, so before funding the buyer must have enough TEUSD **and** have signed an ERC20 `approve(escrow, amount)` transaction. B10 wallets were created with 0 HBAR. An EVM buyer approval will generally need transaction fee funding or a separately implemented and authorized fee-sponsor mechanism. The contract's MINTER_ROLE mints TestEnergyUSD and cannot be assumed to belong to the operator. Do not mix admin, operator, or buyer signing keys.

## Files

- `apps/backend/scripts/b14-trade-core.mjs`: exact match eligibility, deterministic trade identity, integer payment, future window checks, existing-chain conflict detection.
- `apps/backend/scripts/b14-trade-core.test.mjs`: 38 standalone safety/unit tests, no database or Hedera required.
- `apps/backend/scripts/b14-trade-preflight.mjs`: strictly read-only B12/PostgreSQL + B13/Hedera Testnet preflight.
- `README-B14-PHASE-A.md`.

## Installation (PowerShell)

From repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git log -1 --oneline
git status --short

$patch = Join-Path $HOME 'Downloads\B14-trade-creation-funding-phase-A.zip'
if (-not (Test-Path $patch)) { throw 'Missing B14 Phase A ZIP' }
if (Test-Path 'apps/backend/scripts/b14-trade-preflight.mjs') { throw 'B14 exists; inspect before overwriting' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path

node --test apps/backend/scripts/b14-trade-core.test.mjs
node apps/backend/scripts/b14-trade-preflight.mjs --offline
```

Expect **38/38** Node tests and `B14 OFFLINE PASS`.

## Read-only live preflight

This assumes the exact B12 matching result is still in PostgreSQL and the matching-run schema is migrated, the NestJS backend has been built (B12 scripts use `apps/backend/dist/generated/prisma/client.js`), and `HEDERA_NETWORK=testnet`, `DATABASE_URL`, and `HEDERA_TESTNET_RPC_URL` remain configured in the ignored `.env`.

Set a **future** simulated delivery start for the next UTC hour at least two hours away (avoids accidentally selecting a past hour if running close to the boundary):

```powershell
$deliveryStart = (Get-Date).ToUniversalTime().AddHours(3).ToString("yyyy-MM-ddTHH:00:00Z")
$deliveryStart

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b14-trade-preflight.mjs `
    --time-slot '2026-11-09T12:00:00Z' `
    --delivery-start $deliveryStart
  if ($LASTEXITCODE -ne 0) { throw 'B14 Phase A preflight failed' }
}
finally { Pop-Location }
```

Optional: add `--operator-address 0xYOUR_PUBLIC_OPERATOR_ADDRESS` to check OPERATOR_ROLE. Never include or paste a private key in command-line arguments. If multiple matches exist, add `--match-id <UUID>` to select one.

The preflight prints `B14 PLAN` with `externalTradeId`, canonical escrow/token addresses, role readiness, token balance/allowance, and any existing on-chain/local trade. `B14 READ-ONLY PASS` means the selected match and chain state have been checked; **it does not mean funding is ready**. It may say `B14 NEEDS FUNDING SETUP` when buyer TEUSD/allowance are insufficient, which is expected for zero-balance wallets.

Do not commit credentials or snapshot exports. Do not run the old contract `testnet-trade.ts` to create a substitute trade: it uses the smoke-test accounts and a separate synthetic external ID, not the B12 buyer/seller.

## Next Phase B checklist (not implemented in this ZIP)

1. Read the exact current `database/schema.prisma` Trade, Match, BlockchainTransaction models and define a minimal migration for persistent transaction intents. Avoid duplicate trades, independent buyer approvals, duplicate create or funding transactions after uncertain RPC responses. Never reset the DB.
2. Check the public operator EVM address has OPERATOR_ROLE, the admin/minter has MINTER_ROLE, and verify per-user custodial signing is authorized; fund the buyer's HBAR for approval fees according to a separate approved spending policy or use an explicitly validated sponsorship flow.
3. Prepare, sign, and persist a stable transaction hash **before broadcast** for each intended operation; reconcile receipts or chain state on uncertain outcomes. Never re-sign on timeout. Limit to **one** B12 match and use explicit per-operation confirmations and gas budgets.
4. Mint test TEUSD to the actual B12 buyer (admin/minter role), authorize the escrow from the buyer wallet, create the trade via OPERATOR_ROLE, and call fundTrade via operator, only once each and only after verifying the preceding state.
5. Verify the resulting escrow balance, on-chain trade status `AWAITING_DELIVERY`, chain events, and database trade/transaction references. Test retries, partial failures, role failures, insufficient balance, insufficient approval, and impossible delivery windows with mocks before main writes.

**No B14 milestone commit or completion claim until these Phase B actions and tests pass.**
