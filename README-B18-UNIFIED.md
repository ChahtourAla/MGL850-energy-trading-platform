# B18 — Authenticated Trading APIs and Guarded Operator Inspection

## Scope and safety boundary

This package adds an **additive NestJS TradingApiModule**, without changing B14, B15, B16 or B17 code or database tables. It uses the existing B06 JWT authentication, PrismaService and B13 Hedera read-only gateway.

**No HTTP route signs, decrypts wallet keys, broadcasts, plans a persistent transaction, expires/refunds a trade, or updates a Trade.** B14/B16/B17 execution remains in their existing separate, audited CLI workflows. The internal HTTP *preflight* is a policy preview only, **not a substitute for the CLI's chain-time/role/evidence/nonce/receipt verification**. A future separately reviewed execution service would be required for actual write-enabled HTTP endpoints.

This distinction matters: wiring existing B14–B17 signing scripts directly to public HTTP requests would bypass the separation of user identities, spend authority and idempotent transaction journals.

## REST API (JWT)

All routes below require `Authorization: Bearer <JWT>`, obtained from `POST /auth/login`. A user may view only matches/trades for which the verified PostgreSQL `Match` identifies them as buyer or seller. Other users receive 404, including when a record actually exists. Lists require valid UUID cursors and are limited to 50 rows. `BigInt` and Prisma decimals are returned as strings, avoiding JavaScript numeric precision loss.

| Method | Path | Description |
|---|---|---|
| GET | `/trading/matches?limit=20&cursor=<uuid>` | Participant's matches |
| GET | `/trading/matches/:matchId` | One match |
| GET | `/trading/trades?limit=20&cursor=<uuid>` | Participant's trades |
| GET | `/trading/trades/:tradeId` | One trade |
| GET | `/trading/trades/:tradeId/deliveries?limit=20` | Sanitized delivery records |
| GET | `/trading/trades/:tradeId/payments` | Sanitized B14 funding, B16 settlement and B17 recovery journal states |
| GET | `/trading/trades/:tradeId/chain` | Read Hedera Testnet status; verify trade ID, canonical B07 wallets and amounts |

All journal responses omit signed transaction ciphertext, IV, tag, nonce, payloads, oracle evidence and error contents. The on-chain route fails closed on provenance/identity/amount mismatch and reports **both** database and chain status without pretending delayed synchronization has occurred.

## Internal diagnostics (independent server-to-server key)

Set a **separate random 32+ character** environment variable `TRADING_API_READ_ADMIN_KEY` for the backend. Never commit the key or expose it in browser JavaScript. It is intentionally unrelated to B08 import and B10 wallet administration keys. Include it as header `x-trading-read-key`.

| Method | Path | Description |
|---|---|---|
| GET | `/internal/trading/matches/:matchId/workflow` | Read match, trade and B14–B17 journal states; supports simulated accounts without JWT credentials |
| POST | `/internal/trading/matches/:matchId/preflight` | `{ "operation": "ORACLE_CONFIRM" }` (also `CANCEL`, `EXPIRE`, `REFUND`, `DB_RECONCILE`); **read-only** eligibility *preview*, never signs/sends/writes |

The preflight output explicitly includes `executionAuthorized: false` and `blockchainWriteRequested: false`. Even if `candidate` is true, never treat it as authorization for action: the relevant B14/B16/B17 CLI must independently verify role, evidence, time and stored nonce.

## Install on your Windows checkout

From `C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform`:

```powershell
$patch = Join-Path $HOME 'Downloads\B18-unified-backend-apis.zip'
if (-not (Test-Path $patch)) { throw 'B18 ZIP not found in Downloads' }
if (Test-Path 'apps/backend/src/trading-api/trading-api.module.ts') { throw 'B18 already installed; inspect rather than overwrite' }
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path

node --test apps/backend/scripts/b18-api-core.test.mjs tools/install-b18-api.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'B18 policy tests failed' }
node tools/install-b18-api.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'B18 compatibility check failed; DO NOT apply' }
node tools/install-b18-api.mjs --apply
if ($LASTEXITCODE -ne 0) { throw 'B18 module registration failed' }
```

The installer verifies that the existing Prisma schema includes the B12 match, B15 trade, B16 delivery, B14/B16/B17 journals, and B07 wallets. It backs up `app.module.ts` in the OS temporary directory before making the **single additive module import**. It does not write the schema or database. **If the installer stops, inspect the difference rather than changing schema blindly.**

## Full regression tests (required)

```powershell
pnpm exec prisma validate --config prisma7.config.ts
if ($LASTEXITCODE -ne 0) { throw 'Prisma schema invalid' }
pnpm --filter @energy-trading/backend build
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
pnpm --filter @energy-trading/backend typecheck
if ($LASTEXITCODE -ne 0) { throw 'Backend typecheck failed' }
pnpm --filter @energy-trading/backend test
if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed' }
pnpm --filter @energy-trading/backend lint
if ($LASTEXITCODE -ne 0) { throw 'Backend lint failed' }
```

The package additionally contains Vitest tests for the HTTP service and server-side admin read guard. Backend tests must run in your checkout, not merely in the isolated package.

## Live read-only smoke test — existing Testnet trade #2

**Do not log or print your admin credential.** In the same terminal session that starts the backend process, define a fresh read-only admin key. PowerShell compatible with Windows PowerShell 5.1:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$env:TRADING_API_READ_ADMIN_KEY = [Convert]::ToBase64String($bytes)
```

Start the backend using its existing development command (check `apps/backend/package.json` for the script name). Once it is listening, in a **second terminal**, use the same key through your secure local environment configuration; avoid printing it or embedding it in the command history. For a simple smoke test in the *same session* as the environment variable, run the backend in another terminal with that environment variable already passed to it, or use a secret manager. If your backend is already configured with its own `TRADING_API_READ_ADMIN_KEY` in a local ignored `.env`, use that same key in the client.

```powershell
$matchId = '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
$base = 'http://127.0.0.1:3000'  # Adjust to the backend's actual local port
$h = @{ 'x-trading-read-key' = $env:TRADING_API_READ_ADMIN_KEY }
if (-not $h['x-trading-read-key']) { throw 'Internal read key missing in this shell' }
$workflow = Invoke-RestMethod -Method Get -Uri "$base/internal/trading/matches/$matchId/workflow" -Headers $h
if ($workflow.trade.onChainTradeId -ne '2') { throw 'B18 trade linking mismatch' }
$plan = Invoke-RestMethod -Method Post -Uri "$base/internal/trading/matches/$matchId/preflight" -Headers $h -ContentType 'application/json' -Body '{"operation":"ORACLE_CONFIRM"}'
if ($plan.executionAuthorized -ne $false -or $plan.blockchainWriteRequested -ne $false) { throw 'Unsafe B18 operation authorization' }
Write-Host 'B18 INTERNAL READ-ONLY SMOKE PASS'
```

The quoted request is only a preview and never confirms delivery or settles escrow. No new Hedera Testnet trade/transaction is created. For user-facing routes, log in with a **real registered participant account**. Simulated B12 users might not have login credentials; their B15 trade #2 is deliberately available only through the internal diagnostic route.

## Git stage and local commit (after all tests and the live read smoke pass)

```powershell
git diff --check
git add -- apps/backend/src/app.module.ts
git add -- 'apps/backend/src/trading-api/*'
git add -- 'apps/backend/scripts/b18-api-*'
git add -- tools/install-b18-api.mjs tools/install-b18-api.test.mjs README-B18-UNIFIED.md
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
git commit -m 'feat(backend): add authenticated trading and guarded read-only lifecycle APIs'
git status --short --untracked-files=no
```

Do not stage `.env`, `packages/contracts/.env`, encrypted transaction records or unrelated `.agents`, `.claude`, `.windsurf` and `skills-lock.json`. Keep the branch local until B19 final integration.

## Acceptance criteria

1. JWT rejects unauthenticated requests and another user's UUIDs (404).
2. No route leaks encrypted signed transactions, keys, or unvalidated JSON.
3. Correct pagination and lossless micro-USD formatting.
4. Canonical B07 buyer/seller wallets, external ID, trade ID and payment match the live read-only Hedera trade before reporting chain status.
5. Authenticated user endpoints and internal admin endpoints cannot sign, broadcast, refund, expire, or mutate the DB.
6. B14–B17 CLI remain the only reviewed write paths. B19 validates broader end-to-end integration and productionization of action orchestration if required.
