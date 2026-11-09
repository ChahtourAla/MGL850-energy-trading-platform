# B13 — Hedera Smart Contract Integration (read-only; Hedera Testnet)

**Base:** completed B12 commit `543c52f`; 12 matched-energy households and one validated matching record. B13 adds a NestJS read-only contract gateway, a no-key CLI preflight, canonical ABI + Ignition deployment validation, receipt event decoding, and tests. **No Prisma migration, database write, contract deployment, token minting, trade creation, funding, or testnet fee spending in B13.** B14 will separately implement carefully authorized state-changing transactions.

## Boundary and source of truth

- `packages/shared/contracts/deployments/hedera-testnet.json` provides the addresses and status/event mappings.
- The Ignition export under `packages/contracts/ignition/deployments/chain-296/deployed_addresses.json` must match those addresses.
- `packages/shared/contracts/abis/{EnergyTradingEscrow,TestEnergyUSD}.json` provides canonical ABIs. The gateway refuses missing expected ABI functions/events.
- Code checks and view calls target **chain 296 only**. RPC URL must use HTTPS (or loopback HTTP). No private keys are required.
- Node 22+; `ethers` v6 is needed only for live contract calls and event decoding. Safe offline tests require no RPC or `ethers` installation.
- B13 gateway only reads: `verifyDeployment`, `readTrade`, `getOnChainTradeId`, `hasOperatorRole`, `readReceiptEvents`. There are no HTTP routes yet and no signer.
- This ZIP contains **new files only**, plus manual insertion instructions below. Never overwrite existing B01–B12 files.

## 1. Extract and baseline

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
git log -1 --oneline
git status --short

$patch = Join-Path $HOME 'Downloads\B13-hedera-smart-contract-integration.zip'
if (-not (Test-Path $patch)) { throw 'B13 ZIP missing' }
if (Test-Path apps/backend/scripts/b13-contract-preflight.mjs) { throw 'B13 files already exist' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

New files:

```text
README-B13.md
apps/backend/scripts/b13-contract-client.mjs
apps/backend/scripts/b13-contract-client.d.mts
apps/backend/scripts/b13-contract-client.test.mjs
apps/backend/scripts/b13-contract-preflight.mjs
apps/backend/src/hedera-contracts/hedera-contracts.service.ts
apps/backend/src/hedera-contracts/hedera-contracts.service.spec.ts
apps/backend/src/hedera-contracts/hedera-contracts.module.ts
```

## 2. Run offline preflight and native tests (zero RPC calls)

```powershell
node apps/backend/scripts/b13-contract-preflight.mjs
node --test apps/backend/scripts/b13-contract-client.test.mjs
```

Expect `B13 OFFLINE PASS` and **29 passing native tests**. Stop if exported deployment addresses or ABIs differ, and investigate rather than blindly replacing them. The historical repo snapshot contained `EnergyTradingEscrow=0xf60d732EA588499D6984179B6F60f80b2FD67e5D` and `TestEnergyUSD=0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c`, but the canonical committed metadata in your checkout is the authoritative copy.

## 3. Add ethers to the backend workspace

```powershell
pnpm --filter @energy-trading/backend add 'ethers@^6.17.0'
```

This updates `apps/backend/package.json` and `pnpm-lock.yaml`. Do NOT install to the root as an undeclared implicit dependency. B13 itself does not use the Hedera operator private key.

## 4. Register NestJS module

Edit `apps/backend/src/app.module.ts`:

Add this import near the other feature imports:

```typescript
import { HederaContractsModule } from './hedera-contracts/hedera-contracts.module.js';
```

Inside existing `@Module({ imports: [ ... ] })`, add `HederaContractsModule`. Keep all pre-existing B01–B12 imports. There is **no B13 controller**.

## 5. Configuration

Edit `apps/backend/src/config/environment.schema.ts`. In the existing Zod object alongside `HEDERA_NETWORK`, add **only if not already present**:

```typescript
HEDERA_TESTNET_RPC_URL: z.string().url().optional(),
```

Edit `.env.example` and append a public placeholder (no keys):

```dotenv
# B13 read-only Hedera EVM JSON-RPC relay (chain 296)
HEDERA_TESTNET_RPC_URL=https://testnet.hashio.io/api
```

In your **ignored root `.env`**, set:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_TESTNET_RPC_URL=https://testnet.hashio.io/api
```

Do not change `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, or `WALLET_ENCRYPTION_KEY_B64`, and never paste them into chat, tests or Git. If the public RPC is unreliable/rate-limited, use your approved provider's HTTPS Testnet RPC URL instead. Do not use a Mainnet endpoint.

## 6. Build and tests (offline, no HBAR)

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
node --test apps/backend/scripts/b13-contract-client.test.mjs
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

Expected: **29 native B13 tests**, **4 new NestJS service tests** and **144 existing backend tests** (target 148 backend tests if unchanged). Note: new tests have been run only in the reconstructed repository for native tests; full TS/NestJS build and Vitest are to be confirmed in your Windows checkout.

If TypeScript cannot resolve the `.mjs` type declaration, ensure `apps/backend/scripts/b13-contract-client.d.mts` is present next to the `.mjs`. If `HEDERA_TESTNET_RPC_URL` is not visible to ConfigService, ensure you added the optional Zod field to the schema and restarted the app.

## 7. Explicit LIVE Testnet read (NO chain writes)

This only does JSON-RPC reads: `eth_chainId`, `eth_getCode`, and EVM `view` methods. It costs **no HBAR network transaction fees**, creates no trades, and never touches wallet private keys.

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b13-contract-preflight.mjs --live
  if ($LASTEXITCODE -ne 0) { throw 'B13 live preflight failed' }
}
finally { Pop-Location }
```

Expected:

```text
B13 OFFLINE PASS: ...
B13 LIVE PASS: chain=296; bytecode confirmed; payment token matched; decimals=6
B13 STATE: token=<symbol>; escrowPaused=<true/false>; nextTradeId=<integer>
B13 PASS: read-only Hedera Testnet smart contract integration; no transactions, fees, DB changes, or wallet-key access
```

If the URL is unavailable or returns rate limiting, no state changes occurred. Check the endpoint and retry the read-only preflight when available. A mismatched `paymentToken()`, missing bytecode, or a wrong chain ID is a hard failure; do **not** deploy or rewrite historical artifacts automatically.

Optionally, after B14 creates a trade, read an existing ID with `--live --trade-id 1`, or decode known receipt logs with `--live --tx-hash 0x...` (only if you already know a relevant transaction hash). B13 does not manufacture or send a trade in order to test read functionality.

## 8. Commit after full verification

```powershell
git status --short
git diff --check
git check-ignore -v .env

git add README-B13.md
git add apps/backend/scripts/b13-contract-client.mjs
git add apps/backend/scripts/b13-contract-client.d.mts
git add apps/backend/scripts/b13-contract-client.test.mjs
git add apps/backend/scripts/b13-contract-preflight.mjs
git add apps/backend/src/hedera-contracts
git add apps/backend/src/app.module.ts
git add apps/backend/src/config/environment.schema.ts
git add apps/backend/package.json
git add pnpm-lock.yaml
git add .env.example

git diff --cached --check
git diff --cached --stat
# Examine the staged diff before committing; no .env or private keys.
git commit -m 'feat(backend): integrate read-only Hedera Testnet contracts'
git log -1 --oneline
git status --short
```

`git status --short` may still show the unrelated `.agents/`, `.claude/`, `.windsurf/`, and `skills-lock.json` items; keep them out of this commit. B13 does not create a Prisma migration.

## B14 boundary

The B13 gateway is deliberately read-only. B14 will integrate the persisted B12 matches with `createTrade`/`fundTrade`, perform preflight operator authorization checks, enforce idempotent and durable transaction IDs, handle partial on-chain / DB failures, calculate payments using bigint units, and only then enable spending with separate explicit approval and tests. Do not add user private keys, signers, `createTrade` or token transfers into this B13 gateway.
