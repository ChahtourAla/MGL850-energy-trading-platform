# MGL850 B26: one-command OFFLINE regression runner.
# Copy this file into the repository root; run it in Windows PowerShell.
# This executes existing tests. It does NOT implement unbuilt capabilities.
# All database/blockchain harnesses use their own disposable local PostgreSQL/Hardhat fixtures.
# Logs live in the OS temporary directory, outside the Git repository.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root
$required = @(
  'tools/b21-run-postgres-tests.ps1',
  'tools/b22-run-postgres-tests.ps1',
  'tools/b24a1-run-postgres-tests.ps1',
  'tools/b24a2-run-postgres-tests.ps1',
  'tools/b24-wallet-bound-postgres.ps1',
  'tools/b25-run-postgres-tests.ps1',
  'tools/b26-run-postgres-tests.ps1',
  'tools/b26-wallet-bound-postgres.ps1',
  'packages/contracts/test/B25SettlementExecution.ts',
  'packages/contracts/test/B26SixPayableHours.ts',
  'tools/b26-b22-postgres.mjs',
  'apps/backend/scripts/b26-utc-hours.test.mjs'
)
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing required repository file: $file" }
}
foreach ($commandName in @('git', 'node', 'corepack', 'docker', 'powershell.exe')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) { throw "Missing command: $commandName" }
}
$nodeVersion = [version]((& node -p 'process.versions.node').Trim())
if ($nodeVersion -lt [version]'22.22.3') { throw "Node 22.22.3 or newer is required; installed: $nodeVersion" }
& docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not available.' }
& docker image inspect postgres:17 *> $null
if ($LASTEXITCODE -ne 0) { throw 'Local postgres:17 image missing. These tests intentionally avoid pulling images.' }

# Ensure the optional test branches are actually present. Otherwise a green
# suite could silently skip the requested fault injection.
$flagSources = @(
  (Get-Content -Raw -LiteralPath 'packages/contracts/test/B25SettlementExecution.ts'),
  (Get-Content -Raw -LiteralPath 'packages/contracts/test/B25MultiAllocation.ts'),
  (Get-Content -Raw -LiteralPath 'tools/b26-b22-postgres.mjs'),
  (Get-Content -Raw -LiteralPath 'tools/b26-wallet-bound-postgres.ps1')
) -join "`n"

$cases = New-Object 'System.Collections.Generic.List[object]'
function Add-Case {
  param(
    [string]$Name,
    [string]$Program,
    [string[]]$Arguments,
    [hashtable]$Flags = @{},
    [string[]]$Markers = @(),
    [switch]$NeedsMocha
  )
  $cases.Add([pscustomobject]@{
    Name = $Name; Program = $Program; Arguments = $Arguments;
    Flags = $Flags; Markers = $Markers; NeedsMocha = [bool]$NeedsMocha
  })
}
function Add-Harness {
  param([string]$Name, [string]$Script, [hashtable]$Flags = @{}, [string[]]$Markers = @(), [switch]$NeedsMocha)
  Add-Case -Name $Name -Program 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) -Flags $Flags -Markers $Markers -NeedsMocha:$NeedsMocha
}

# Static and in-process checks.
Add-Case 'Git whitespace check' 'git' @('diff', '--check')
Add-Case 'B26 UTC/calendar unit tests' 'node' @('--test', 'apps/backend/scripts/b26-utc-hours.test.mjs') @{} @('# tests 4')
Add-Case 'B26 supervisor IPC disconnect/replay unit tests' 'node' @('--test', 'apps/backend/scripts/b26-supervisor-ipc.test.mjs') @{} @('# tests 3')
Add-Case 'Backend TypeScript typecheck' 'corepack' @('pnpm', '--dir', 'apps/backend', 'typecheck')
Add-Case 'Backend lint' 'corepack' @('pnpm', '--dir', 'apps/backend', 'lint')
Add-Case 'Full backend Vitest suite' 'corepack' @('pnpm', '--dir', 'apps/backend', 'test')
Add-Case 'Direct settlement contract tests' 'corepack' @('pnpm', '--dir', 'packages/contracts', 'exec', 'hardhat', 'test', '--no-compile', 'test/EnergyTradingDirectSettlement.ts')

# Regression harnesses with fresh, disposable databases.
Add-Harness 'B21 PostgreSQL regression' '.\tools\b21-run-postgres-tests.ps1'
Add-Harness 'B22 PostgreSQL regression' '.\tools\b22-run-postgres-tests.ps1'
Add-Harness 'B24 authorization regression' '.\tools\b24a1-run-postgres-tests.ps1'
Add-Harness 'B24 signing preflight regression' '.\tools\b24a2-run-postgres-tests.ps1'
Add-Harness 'B24 wallet-bound regression' '.\tools\b24-wallet-bound-postgres.ps1'
Add-Harness 'B26 DB, API privilege and matching regression' '.\tools\b26-run-postgres-tests.ps1' @{} @('PASS B26 scheduler verifies genuine finalized B22 snapshot')
Add-Harness 'B26 long B22 matching lease' '.\tools\b26-run-postgres-tests.ps1' @{B26_TEST_LONG_LEASE='1'} @('PASS B26 real worker lease survived >60-second B22 matching delay')

# Autonomous wallet-bound B26 scenarios; the local test harness itself sets
# B26_TEST_24_HOURS=1 and B26_TEST_COORDINATOR=1.
Add-Harness 'B26 24-hour mixed-state and multi-allocation' '.\tools\b26-wallet-bound-postgres.ps1' @{} @('B26_24_HOURS', 'B26_MULTI') -NeedsMocha
Add-Harness 'B26 six payable hours and process restart' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_SIX_HOURS_ONLY='1'} @('B26_SIX_PAYABLE') -NeedsMocha
Add-Harness 'B26 stale worker before handoff' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_HANDOFF_RACE='1'} @('2 passing') -NeedsMocha
Add-Harness 'B26 lease takeover after handoff' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_POST_HANDOFF_RACE='1'} @('2 passing') -NeedsMocha
Add-Harness 'B26 crash after handoff' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_CRASH_AFTER_HANDOFF='1'} @('2 passing') -NeedsMocha
Add-Harness 'B26 crash after broadcast' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_CRASH_AFTER_BROADCAST='1'} @('2 passing') -NeedsMocha
Add-Harness 'B26 long B24 signing preflight lease' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_SIGNING_LEASE='1'} @('PASS B26 signing-preflight wait exceeded 60 seconds', 'B26_24_HOURS') -NeedsMocha
Add-Harness 'B26 long funding lease' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_FUNDING_LEASE='1'} @('PASS B26 funding wait exceeded 60 seconds', 'B26_24_HOURS') -NeedsMocha
Add-Harness 'B26 long allowance lease' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_ALLOWANCE_LEASE='1'} @('PASS B26 allowance wait exceeded 60 seconds', 'B26_24_HOURS') -NeedsMocha

# Added fixture-only signer process restart; asserts previously unsigned reservation
# is signed in a fresh process and existing 2-allocation market still settles.
Add-Harness 'B26 disposable signer process restart and new unsigned allocation' '.\tools\b26-wallet-bound-postgres.ps1' @{B26_TEST_SIGNER_RESTART='1'} @('PASS B26 disposable signer restarted in a separate process', 'B26_MULTI') -NeedsMocha

# B25 financial fault-injection suite. These are existing B25 regression
# branches, not claims of end-to-end B26 scheduler fault coverage.
Add-Harness 'B25 baseline local settlement' '.\tools\b25-run-postgres-tests.ps1' @{} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 executor RPC timeout' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_EXECUTOR_TIMEOUT='1'} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 recovery RPC timeout' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_RECOVERY_TIMEOUT='1'} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 signing timeout' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_SIGN_TIMEOUT='1'} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 canonical outcome supersession' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_SUPERSESSION='1'} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 concurrent authorization conflict' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_CONCURRENT_CONFLICT='1'} @('B25_LOCAL_TEST_ONLY') -NeedsMocha
Add-Harness 'B25 before-send response loss' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_BROADCAST_FAILURE='before'} @('passing') -NeedsMocha
Add-Harness 'B25 after-send response loss' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_BROADCAST_FAILURE='after'} @('passing') -NeedsMocha
Add-Harness 'B25 lost handoff response' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_LOST_HANDOFF_RESPONSE='1'} @('passing') -NeedsMocha
Add-Harness 'B25 nonce conflict before handoff' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_NONCE_CONFLICT='1'} @('passing') -NeedsMocha
Add-Harness 'B25 revoke before handoff' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_REVOKE_BEFORE_HANDOFF='1'} @('passing') -NeedsMocha
Add-Harness 'B25 retire deployment before handoff' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_RETIRE_BEFORE_HANDOFF='1'} @('passing') -NeedsMocha
Add-Harness 'B25 revoke before execution' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_REVOKE_BEFORE_EXECUTE='1'} @('passing') -NeedsMocha
Add-Harness 'B25 retired session' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_RETIRED_SESSION='1'} @('passing') -NeedsMocha
Add-Harness 'B25 expired authorization' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_EXPIRED='1'} @('passing') -NeedsMocha
Add-Harness 'B25 process crash while prepared; recovery scan timeout' '.\tools\b25-run-postgres-tests.ps1' @{B25_PROCESS_CRASH_POINT='prepared'; B25_TEST_SCAN_TIMEOUT='1'} @('passing') -NeedsMocha
Add-Harness 'B25 process crash after handoff' '.\tools\b25-run-postgres-tests.ps1' @{B25_PROCESS_CRASH_POINT='handoff'} @('passing') -NeedsMocha
Add-Harness 'B25 process crash after broadcast' '.\tools\b25-run-postgres-tests.ps1' @{B25_PROCESS_CRASH_POINT='broadcast'} @('passing') -NeedsMocha
Add-Harness 'B25 process crash after chain revert' '.\tools\b25-run-postgres-tests.ps1' @{B25_PROCESS_CRASH_POINT='revert'} @('passing') -NeedsMocha
Add-Harness 'B25 two-allocation reverted payment' '.\tools\b25-run-postgres-tests.ps1' @{B25_TEST_MULTI_ONLY='1'; B25_TEST_REVERT='1'} @('passing') -NeedsMocha

# Abort before executing anything if an optional flag has disappeared from
# the source and could therefore silently make a special-case test a no-op.
foreach ($scenario in $cases) {
  foreach ($flag in $scenario.Flags.Keys) {
    if ($flag -eq 'B25_TEST_MULTI_ONLY') { continue } # harness flag
    if ($flag -eq 'B26_SIX_HOURS_ONLY') { continue }   # harness flag
    if ($flagSources.IndexOf([string]$flag, [StringComparison]::Ordinal) -lt 0) {
      throw "Cannot prove coverage: flag $flag for '$($scenario.Name)' was not found in repository test source."
    }
  }
}

# The child PowerShell process running this runner is isolated from the user's
# parent terminal. Still clear all mode flags between cases to avoid leakage.
$testFlagNames = @($cases | ForEach-Object { $_.Flags.Keys } | Sort-Object -Unique)
$testFlagNames += @('B26_TEST_COORDINATOR', 'B26_TEST_24_HOURS')
$logRoot = Join-Path ([IO.Path]::GetTempPath()) ('mgl850-b26-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$results = New-Object 'System.Collections.Generic.List[object]'
Write-Host ("MGL850 OFFLINE acceptance: {0} scenarios" -f $cases.Count)
Write-Host "Logs: $logRoot"
Write-Host 'No test uses live Hedera keys or submits real payments.'

for ($i = 0; $i -lt $cases.Count; $i++) {
  $scenario = $cases[$i]
  foreach ($flag in $testFlagNames) { Remove-Item "Env:$flag" -ErrorAction SilentlyContinue }
  foreach ($flag in $scenario.Flags.Keys) {
    [Environment]::SetEnvironmentVariable([string]$flag, [string]$scenario.Flags[$flag], 'Process')
  }
  $fileNumber = ('{0:D2}' -f ($i + 1))
  $safeName = ($scenario.Name -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLowerInvariant()
  $log = Join-Path $logRoot "$fileNumber-$safeName.log"
  Write-Host ("[{0}/{1}] RUN {2}" -f ($i + 1), $cases.Count, $scenario.Name)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $success = $false
  $message = ''
  try {
    # Native child calls retain their exit code. Capture their full output in
    # a separate log instead of flooding the console with 44 migrations/run.
    $global:LASTEXITCODE = 0
    $ErrorActionPreference = 'Continue'
    $invokeArgs = [string[]]$scenario.Arguments
    & $scenario.Program @invokeArgs *> $log
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "Child process exit code $exitCode" }
    $output = Get-Content -Raw -LiteralPath $log
    foreach ($marker in $scenario.Markers) {
      if (-not $output.Contains($marker)) { throw "Missing success marker: $marker" }
    }
    if ($scenario.NeedsMocha -and $output -notmatch '(?m)\b\d+\s+passing\b') {
      throw 'Mocha test-pass summary missing'
    }
    $success = $true
  }
  catch {
    $message = $_.Exception.Message
  }
  finally {
    $ErrorActionPreference = 'Stop'
    $watch.Stop()
    foreach ($flag in $testFlagNames) { Remove-Item "Env:$flag" -ErrorAction SilentlyContinue }
  }
  $results.Add([pscustomobject]@{
    Number = $i + 1; Scenario = $scenario.Name;
    Result = $(if ($success) { 'PASS' } else { 'FAIL' });
    Seconds = [math]::Round($watch.Elapsed.TotalSeconds,1);
    Detail = $message; Log = $log
  })
  if ($success) { Write-Host ("  PASS ({0:N1}s)" -f $watch.Elapsed.TotalSeconds) }
  else {
    Write-Host ("  FAIL: {0}" -f $message) -ForegroundColor Red
    Write-Host "  Last log lines:"
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 30 }
    # Keep running so that the final report identifies every broken scenario.
  }
}

$reportPath = Join-Path $logRoot 'results.json'
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
$passed = $results.Count - $failed.Count
Write-Host ''
Write-Host ("REGRESSION RESULT: {0}/{1} PASS; {2} FAIL" -f $passed, $results.Count, $failed.Count)
Write-Host "Summary: $reportPath"
if ($failed.Count -gt 0) {
  Write-Host 'Failed scenarios and their log files:' -ForegroundColor Red
  $failed | Select-Object Scenario, Detail, Log | Format-List | Out-Host
  Write-Host 'B26 acceptance: NOT READY (regressions detected).' -ForegroundColor Red
  exit 1
}
Write-Host 'All existing regression scenarios in this runner passed.' -ForegroundColor Green
Write-Host 'B26 is NOT automatically complete: full signer-supervisor restart/new unsigned allocation and complete B26-specific adversarial coverage remain independent acceptance requirements.' -ForegroundColor Yellow
exit 0
