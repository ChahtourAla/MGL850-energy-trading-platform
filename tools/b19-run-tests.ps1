# B19 deterministic local-only validation. NO Testnet transaction actions are invoked.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Test-Path 'prisma7.config.ts') -or -not (Test-Path 'apps/backend/package.json')) {
    throw 'Run this script from the repository root.'
}
function Run-Checked {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "B19 CHECK: $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "B19 FAILED: $Name (exit $LASTEXITCODE)" }
    Write-Host "B19 PASS: $Name"
}
Run-Checked 'B19 code syntax' { node --check apps/backend/scripts/b19-audit.mjs }
Run-Checked 'Prisma validate' { pnpm exec prisma validate --config prisma7.config.ts }
$tests = @(
    Get-ChildItem -Path 'apps/backend/scripts' -Filter '*.test.mjs' -File | ForEach-Object { $_.FullName }
)
$tests += @(Get-ChildItem -Path 'tools' -Filter '*.test.mjs' -File | ForEach-Object { $_.FullName })
if ($tests.Count -lt 8) { throw 'Expected B13-B19 and installer tests are missing. Stop.' }
Run-Checked 'B13-B19 JS safety and installer regression tests' { node --test @tests }
Run-Checked 'Python delivery generator isolated smoke' { node apps/backend/scripts/b16-python-smoke.mjs }
Run-Checked 'Hardhat contract unit tests, local network only' { pnpm --filter @energy-trading/contracts test }
Run-Checked 'NestJS production build' { pnpm --filter @energy-trading/backend build }
Run-Checked 'NestJS TypeScript validation' { pnpm --filter @energy-trading/backend typecheck }
Run-Checked 'NestJS Vitest and HTTP e2e tests (mocked external services)' { pnpm --filter @energy-trading/backend test }
Run-Checked 'NestJS lint' { pnpm --filter @energy-trading/backend lint }
Run-Checked 'Git whitespace check' { git diff --check }
Write-Host 'B19 OFFLINE VALIDATION PASS: no live Hedera write, no escrow/DB state mutation requested'
