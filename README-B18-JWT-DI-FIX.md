# B18 — Fix NestJS JwtAuthGuard module dependency resolution

## Why the earlier tests failed

`TradingApiController` is owned by `TradingApiModule`. Direct `@UseGuards(JwtAuthGuard)` caused NestJS to instantiate the JWT guard in the trading module, but that module does not own `JwtService` and `UsersService`. The actual `AuthModule` already owns, configures and exports `JwtAuthGuard`. Do **not** register `JwtModule` again with a different secret or duplicate the JWT verification logic.

## Change

`TradingApiJwtGuard` lives in `TradingApiModule` and *injects* the `JwtAuthGuard` instance exported by `AuthModule`. Every `canActivate` call delegates without swallowing any exceptions or changing the result. The existing JWT, user DB lookup, issuer, audience, and expiry checks remain enforced by the original guard.

The fix replaces only `trading-api.module.ts` and `trading-api.controller.ts` and adds a dedicated guard, its Vitest tests, and a Node wiring check. No schema/database migration and no blockchain transactions.

## Windows installation

With the patch ZIP downloaded to Downloads and from the repository root:

```powershell
$patch = Join-Path $HOME 'Downloads\B18-JWT-dependency-injection-fix.zip'
if (-not (Test-Path $patch)) { throw 'B18 fix ZIP not found' }
if (-not (Test-Path 'apps/backend/src/trading-api/trading-api.module.ts')) { throw 'B18 base module is missing; stop' }

$backup = Join-Path $env:TEMP ('b18-jwt-backup-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item apps/backend/src/trading-api/trading-api.module.ts $backup
Copy-Item apps/backend/src/trading-api/trading-api.controller.ts $backup
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path -Force

node --test apps/backend/scripts/b18-auth-di-wiring.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'JWT DI wiring check failed' }
pnpm --filter @energy-trading/backend build
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
pnpm --filter @energy-trading/backend typecheck
if ($LASTEXITCODE -ne 0) { throw 'TypeScript typecheck failed' }
pnpm --filter @energy-trading/backend test
if ($LASTEXITCODE -ne 0) { throw 'Backend Vitest failed' }
pnpm --filter @energy-trading/backend lint
if ($LASTEXITCODE -ne 0) { throw 'Lint failed' }
```

Expected: the 5 previously failing e2e suites instantiate normally, and the 3 new JWT delegate unit tests pass. If another error appears, inspect the first real Nest DI exception rather than treating cascaded afterAll cleanup errors as the cause.

Do not commit until the backend regressions and an authenticated live HTTP smoke test pass. Do not stage .env or wallet keys. Keep B14-B17 transaction journals unchanged.
