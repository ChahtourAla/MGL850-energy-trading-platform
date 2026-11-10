# B19 live audit fix — optional Prisma Trade.chainId

The B19 offline test fixture assumed that `Trade.chainId` existed. In B15 the schema-driven `Trade` projection only writes `chainId` if the actual `Trade` model has that field. When it does not, the B19 live audit stopped at `Invalid DB chainId` even when the deployed Hedera chain is correct.

## Changes

- `b19-audit-core.mjs` exports `tradeSchemaHasChainId()` and requires the validated presence/absence of the column to match the actual full Prisma result.
- If the column exists, `Trade.chainId` must be a canonical integer equal to 296. Null, malformed or incorrect values are rejected.
- If it does not exist, the validator relies on verified deployment chain 296 plus **each of the five CONFIRMED B14 journal rows**: every row must have `chainId=296` and the same external trade ID as the DB Trade, with matching on-chain transaction receipts. This check applies even when the DB column exists.
- `b19-audit.mjs` reads `database/schema.prisma` before checking the DB record. The script is read-only and still has no signing, broadcasting or database writes.
- `b19-audit-core.test.mjs` adds eight regression tests. Total local B19 audit tests: **82/82**.

## Install — after original B19 package

From the repository root (PowerShell):

```powershell
$patch = Join-Path $HOME 'Downloads\B19-chain-provenance-fix.zip'
if (-not (Test-Path $patch)) { throw 'B19 fix ZIP missing' }
$backup = Join-Path $env:TEMP ('b19-chain-fix-' + (Get-Date -Format yyyyMMddHHmmss))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($f in @('b19-audit-core.mjs','b19-audit-core.test.mjs','b19-audit.mjs')) {
  Copy-Item (Join-Path 'apps/backend/scripts' $f) $backup
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path -Force
node --check apps/backend/scripts/b19-audit.mjs
if ($LASTEXITCODE -ne 0) { throw 'Syntax failed' }
node --test apps/backend/scripts/b19-audit-core.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
```

## Retry real audit (read-only)

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b19-audit.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a'
  if ($LASTEXITCODE -ne 0) { throw 'B19 audit failed; inspect exact error' }
} finally { Pop-Location }
```

If the audit flags another mismatch, stop and investigate; do not change the schema to add a chainId column, reset PostgreSQL, or send/retry any blockchain transactions.
