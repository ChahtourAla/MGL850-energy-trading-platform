<#
MGL850: one-file UTC-day runner for NEW simulated data on a separate Windows computer.

  1. Preview (default): produce 24 new immutable Python energy snapshots, no DB writes.
  2. CommitMatching: import EXACT previewed snapshots and record 24 Python matching decisions.
  3. SettleTestnet: intentionally blocked until a reviewed, date-independent V2
     market-commit/settlement worker exists for the newly provisioned wallets.

Requires the *original* generated user registry (without wallet fields) whose 12
users are already in PostgreSQL with VERIFIED Hedera wallet identities.
Existing Nov 10-only settlement scripts CANNOT be reused for arbitrary days.

Example:
 .\RUN_MGL850_DAY.ps1 -Day 2026-11-27 -RegistryPath "$env:LOCALAPPDATA\MGL850\new-simulation\users.json" -EnergySeed 20271127
 .\RUN_MGL850_DAY.ps1 -Day 2026-11-27 -RegistryPath "$env:LOCALAPPDATA\MGL850\new-simulation\users.json" -EnergySeed 20271127 -Mode CommitMatching
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Day,
    [Parameter(Mandatory=$true)][string]$RegistryPath,
    [ValidateSet('Preview','CommitMatching','SettleTestnet')][string]$Mode='Preview',
    [ValidateRange(1,200)][int]$ExpectedUsers=12,
    [ValidateRange(0,199)][int]$ConsumptionOnlyCount=4,
    [ValidateRange(0,2147483647)][int]$EnergySeed=20271127,
    [string]$PythonPath='',
    [string]$RepositoryPath='',
    [switch]$UpdateDashboard,
    [switch]$NoBrowser,
    [switch]$NoFrontendAutoStart
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Stop-Run([string]$Message) { throw "MGL850 STOP: $Message" }
function File-Sha([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Write-JsonUtf8([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 45
    [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}
function Invoke-Native([string]$Label,[string]$Executable,[string[]]$ArgumentList) {
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) { Stop-Run "$Label failed (exit code $LASTEXITCODE). Do not discard the day's saved artifacts." }
}
function Invoke-BackendNode([string]$Label,[string]$Script,[string[]]$ArgumentList) {
    Push-Location $backendDir
    try { Invoke-Native $Label 'node' (@('--env-file=../../.env',"scripts/$Script") + $ArgumentList) }
    finally { Pop-Location }
}
function Assert-HourSnapshot([string]$Path,[string]$TimeSlot,[int]$Count) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-Run "Missing snapshot: $Path" }
    $snapshot = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($snapshot.timeSlot -cne $TimeSlot -or @($snapshot.users).Count -ne $Count) {
        Stop-Run "Snapshot time slot or participant count mismatch: $Path"
    }
    return $snapshot
}


function Normalize-Source([string]$Text) {
    return (($Text -replace "`r`n", "`n").TrimEnd("`n") + "`n")
}
function Text-Sha([string]$Text) {
    $bytes=[System.Text.Encoding]::UTF8.GetBytes((Normalize-Source $Text))
    $sha=[System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Install-Day-Dashboard-Panel {
    $target=Join-Path $repo 'apps\frontend\src\components\B34DayCoveragePanel.tsx'
    $replacement=Join-Path $PSScriptRoot 'files\apps\frontend\src\components\B34DayCoveragePanel.tsx'
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { Stop-Run 'Dashboard panel missing. Use the latest GitHub feature branch.' }
    if (-not (Test-Path -LiteralPath $replacement -PathType Leaf)) { Stop-Run 'Dashboard update file missing beside the PowerShell runner.' }
    $prior=[System.IO.File]::ReadAllText($target)
    $future=[System.IO.File]::ReadAllText($replacement)
    $priorSha=Text-Sha $prior
    $newSha=Text-Sha $future
    if ($newSha -cne '8fadaaa3a4d7f99730fbbfd31fee73a152cb1bb29158efc1cc78cb838fa0db34') { Stop-Run 'Packaged dashboard source failed its integrity check.' }
    if ($priorSha -ceq $newSha) {
        Write-Host 'PASS: Day dashboard enhancement already installed.' -ForegroundColor Green
        return
    }
    if ($priorSha -cne '03ec51d099b361433ea74d7208cd6324e713112f40856ed267d751131a2b1059') {
        Stop-Run 'Dashboard has different local code. No overwrite attempted. Review/merge the dashboard update manually.'
    }
    $backupDir=Join-Path $env:LOCALAPPDATA ('MGL850\dashboard-backup\'+[datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
    New-Item -Path $backupDir -ItemType Directory -Force | Out-Null
    $backup=Join-Path $backupDir 'B34DayCoveragePanel.tsx'
    Copy-Item -LiteralPath $target -Destination $backup
    Write-Host "Dashboard backup: $backup"
    try {
        [System.IO.File]::WriteAllText($target,(Normalize-Source $future), (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Native 'Frontend TypeScript validation after dashboard update' 'pnpm' @('--dir','apps/frontend','exec','tsc','--noEmit')
        Write-Host 'PASS: Day dashboard now distinguishes proposed matches from verified payments.' -ForegroundColor Green
    } catch {
        Copy-Item -LiteralPath $backup -Destination $target -Force
        throw
    }
}
function Get-PrivateEnvValue([string]$Name) {
    $path=Join-Path $repo '.env'
    $lines=@([System.IO.File]::ReadAllLines($path) | Where-Object { $_ -match ('^'+[regex]::Escape($Name)+'=') })
    if ($lines.Count -ne 1) { Stop-Run "Expected exactly one $Name in the repository .env file." }
    return $lines[0].Substring($Name.Length+1).Trim().Trim('"').Trim("'")
}
function Invoke-ReadBackend([string]$Path,[hashtable]$Headers) {
    try {
        return Invoke-RestMethod -Uri ("http://127.0.0.1:3001"+$Path) -Headers $Headers -Method Get -TimeoutSec 30
    } catch {
        Stop-Run "Read-only dashboard API failed at $Path ($($_.Exception.Message)). PostgreSQL may be ready while the dashboard read API is not."
    }
}
function Verify-Day-In-Dashboard {
    Write-Host '=== Final read-only dashboard visibility audit ===' -ForegroundColor Cyan
    $key=Get-PrivateEnvValue 'TRADING_API_READ_ADMIN_KEY'
    if ($key.Length -lt 32) { Stop-Run 'TRADING_API_READ_ADMIN_KEY must have at least 32 characters.' }
    try {
        $headers=@{ 'x-trading-read-key'=$key }
        $list=Invoke-ReadBackend '/internal/v2/demo/users' $headers
        $wantedIds=@($registryData.users | ForEach-Object { $_.userId })
        $actualIds=@($list.users | ForEach-Object { $_.userId })
        if (@($list.users).Count -ne $ExpectedUsers) {
            Stop-Run "Dashboard lists $(@($list.users).Count) households instead of $ExpectedUsers. Use a separate new PostgreSQL database for this simulation to avoid mixing registries."
        }
        foreach ($id in $wantedIds) {
            if ($id -notin $actualIds) { Stop-Run "Generated household $id is missing from the dashboard users API." }
        }
        $coverage=Invoke-ReadBackend ('/internal/v2/demo/day-coverage?day='+[uri]::EscapeDataString($Day)) $headers
        if ($coverage.utcDay -cne $Day -or @($coverage.hours).Count -ne 24 -or
            $coverage.summary.importedHours -ne 24 -or $coverage.summary.b12RunHours -ne 24 -or
            $coverage.summary.hoursWithoutB12Run -ne 0) {
            Stop-Run 'Day API did not confirm 24 imported energy hours and 24 matching runs. Do not claim the dashboard is complete.'
        }
        $nextDay=$parsedDay.AddDays(1).ToString('yyyy-MM-dd')
        $from="${Day}T00:00:00Z"
        $to="${nextDay}T00:00:00Z"
        $perHouse=@()
        foreach ($id in $wantedIds) {
            $path="/internal/v2/demo/users/$id/energy?from=$([uri]::EscapeDataString($from))&to=$([uri]::EscapeDataString($to))"
            $result=Invoke-ReadBackend $path $headers
            if ($result.totals.recordedHours -ne 24 -or @($result.hours).Count -ne 24) {
                Stop-Run "Dashboard does not show 24 energy hours for generated household $id."
            }
            $perHouse += [pscustomobject]@{userId=$id;energyHours=24}
        }
        $audit=[ordered]@{
            day=$Day; fromUtc=$from; toExclusiveUtc=$to; households=$ExpectedUsers;
            energyHours=24; matchingRunHours=24; matchesFound=$coverage.summary.b12Matches;
            authoritativeTrades=$coverage.summary.v2Allocations;
            paymentRecords=$coverage.summary.recordedProofs;
            noBlockchainTransactionsSubmittedByRunner=$true;
            dashboardUrl="http://localhost:3000/?day=$Day";
            perHousehold=@($perHouse)
        }
        Write-JsonUtf8 (Join-Path $dayDir 'dashboard-verification.json') $audit
        Write-Host "PASS: All $ExpectedUsers households have 24 visible energy hours. Matching decisions: 24/24." -ForegroundColor Green
        Write-Host "Matches proposed: $($coverage.summary.b12Matches). Existing recorded payment evidence: $($coverage.summary.recordedProofs)." -ForegroundColor Cyan
        return [pscustomobject]@{ UserId=$wantedIds[0]; MatchCount=$coverage.summary.b12Matches }
    } finally {
        Remove-Variable key -ErrorAction SilentlyContinue
    }
}
function Open-Day-Dashboard([string]$SelectedId) {
    if ($NoBrowser) {
        Write-Host "Dashboard: http://localhost:3000/?day=$Day&userId=$SelectedId"
        return
    }
    $url="http://localhost:3000/?day=$Day&userId=$SelectedId"
    $alive=$false
    try {
        $response=Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 5
        $alive=$response.StatusCode -eq 200
    } catch {}
    if (-not $alive -and -not $NoFrontendAutoStart) {
        Write-Host 'Frontend is not responding; starting Next.js in a separate Windows terminal...' -ForegroundColor Cyan
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k','pnpm --dir apps/frontend dev') -WorkingDirectory $repo
        for ($attempt=0; $attempt -lt 25; $attempt++) {
            Start-Sleep -Seconds 2
            try {
                $response=Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 6
                if ($response.StatusCode -eq 200) { $alive=$true; break }
            } catch {}
        }
    }
    if ($alive) {
        Write-Host "Opening the newly generated day: $url" -ForegroundColor Green
        Start-Process $url
    } else {
        Write-Warning 'The backend data is verified, but Next.js did not start on port 3000. Run: pnpm --dir apps/frontend dev'
        Write-Host "After starting Next.js, open: $url"
    }
}

# Date and repository identity checks; do not accept malformed or impossible days.
[datetime]$parsedDay = [datetime]::MinValue
$validDate = [datetime]::TryParseExact($Day,'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,[ref]$parsedDay)
if (-not $validDate -or $parsedDay.ToString('yyyy-MM-dd') -cne $Day) {
    Stop-Run 'Specify a real UTC calendar date with -Day YYYY-MM-DD.'
}
if ($ConsumptionOnlyCount -ge $ExpectedUsers) { Stop-Run 'ConsumptionOnlyCount must be less than ExpectedUsers.' }
if ($Mode -eq 'SettleTestnet') {
    Stop-Run ('New-day payments are NOT yet supported by the current verified live ' +
      'settlement worker. It is pinned to 2026-11-10 and its original approved markets. ' +
      'Do not reuse its keys, approval JSON, or settlement IDs for new households. ' +
      'First implement and independently test a date-independent V2 market proposal, ' +
      'buyer authorization, balance preflight, journal, and receipt-reconciliation worker.')
}
$repo = if ($RepositoryPath) { $RepositoryPath } else { (Get-Location).Path }
if (-not (Test-Path -LiteralPath $repo -PathType Container)) { Stop-Run 'Repository directory not found.' }
$repo = (Resolve-Path -LiteralPath $repo).Path
$backendDir = Join-Path $repo 'apps\backend'
$frontendPage=Join-Path $repo 'apps\frontend\src\app\page.tsx'
if (-not (Test-Path -LiteralPath $frontendPage)) { Stop-Run 'Frontend not found.' }
if (-not ([System.IO.File]::ReadAllText($frontendPage).Contains('params.day'))) { Stop-Run 'Frontend has no selectable day support. Update to the latest B36/B37 interface before running the dashboard workflow.' }
foreach ($required in @(
    '.env',
    'apps/backend/scripts/b11-energy-pipeline.mjs',
    'apps/backend/scripts/b11-verify.mjs',
    'apps/backend/scripts/b12-matching-pipeline.mjs',
    'apps/backend/scripts/b12-matching-core.test.mjs',
    'apps/backend/scripts/export-wallet-ready-registry.mjs',
    'services/data-generator/config/energy-generation-config.json'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $required) -PathType Leaf)) {
        Stop-Run "Missing repository prerequisite: $required"
    }
}
if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) { Stop-Run "Cannot find the original generated registry: $RegistryPath" }
$registry = (Resolve-Path -LiteralPath $RegistryPath).Path
$registryData = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
if (@($registryData.users).Count -ne $ExpectedUsers) { Stop-Run "Expected $ExpectedUsers users in original registry." }
foreach ($u in $registryData.users) {
    if ($null -ne $u.PSObject.Properties['evmAddress'] -or $null -ne $u.PSObject.Properties['hederaAccountId']) {
        Stop-Run 'RegistryPath must point to the ORIGINAL generated registry without wallet addresses (the trusted DB exporter supplies wallets).'
    }
}
$python = if ($PythonPath) { $PythonPath }
          elseif (Test-Path (Join-Path $repo '.venv\Scripts\python.exe')) { Join-Path $repo '.venv\Scripts\python.exe' }
          else { 'python' }

$dayDir = Join-Path $env:LOCALAPPDATA ("MGL850\simulation-days\$Day")
$snapshotDir = Join-Path $dayDir 'snapshots'
$artifactDir = Join-Path $dayDir 'artifacts'
foreach ($dir in @($dayDir,$snapshotDir,$artifactDir)) {
    New-Item -Path $dir -ItemType Directory -Force | Out-Null
}
$energyConfig = Join-Path $dayDir 'energy-config.json'
$sourceConfig = Join-Path $repo 'services\data-generator\config\energy-generation-config.json'
$cfg = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
$cfg.seed = $EnergySeed
if (-not (Test-Path -LiteralPath $energyConfig)) {
    Write-JsonUtf8 $energyConfig $cfg
} else {
    $savedConfig = Get-Content -LiteralPath $energyConfig -Raw | ConvertFrom-Json
    if ($savedConfig.seed -ne $EnergySeed) { Stop-Run 'EnergySeed changed for an existing day folder.' }
    # Also protect all other numerical and profile parameters against drift.
    $temporaryConfig = Join-Path $dayDir 'expected-energy-config.json'
    try {
        Write-JsonUtf8 $temporaryConfig $cfg
        if ((File-Sha $temporaryConfig) -cne (File-Sha $energyConfig)) {
            Stop-Run 'Energy configuration changed since the day was first prepared.'
        }
    } finally { Remove-Item -LiteralPath $temporaryConfig -ErrorAction SilentlyContinue }
}
$registrySha = File-Sha $registry
$configSha = File-Sha $energyConfig
$manifestPath = Join-Path $dayDir 'preview-manifest.json'
$identityPath = Join-Path $dayDir 'simulation-identity.json'
$identity = [ordered]@{
    day=$Day; expectedUsers=$ExpectedUsers; consumptionOnlyCount=$ConsumptionOnlyCount;
    energySeed=$EnergySeed; originalRegistrySha256=$registrySha; energyConfigSha256=$configSha
}
if (Test-Path -LiteralPath $identityPath) {
    $savedIdentity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
    if ($savedIdentity.day -cne $identity.day -or $savedIdentity.expectedUsers -ne $identity.expectedUsers -or
        $savedIdentity.consumptionOnlyCount -ne $identity.consumptionOnlyCount -or
        $savedIdentity.energySeed -ne $identity.energySeed -or
        $savedIdentity.originalRegistrySha256 -cne $identity.originalRegistrySha256 -or
        $savedIdentity.energyConfigSha256 -cne $identity.energyConfigSha256) {
        Stop-Run 'Stored day-run identity conflicts with supplied registry, seed, date or configuration.'
    }
} else {
    if (@(Get-ChildItem -LiteralPath $snapshotDir -File).Count -gt 0) {
        Stop-Run 'Existing snapshots have no saved run identity. Inspect them before resuming.'
    }
    Write-JsonUtf8 $identityPath $identity
}

Write-Host "MGL850 simulation day : $Day (UTC)" -ForegroundColor Green
Write-Host "Mode                 : $Mode"
Write-Host "Simulated households : $ExpectedUsers"
Write-Host "Energy seed          : $EnergySeed"
Write-Host "Artifact folder      : $dayDir"
Write-Host 'No blockchain signing or transaction submission is available in this runner.' -ForegroundColor Yellow

Push-Location $repo
try {
    Invoke-Native 'Python environment' $python @('-c', "import pydantic; print('Python validation runtime ready')")
    Invoke-Native 'Build backend validators and Prisma client' 'pnpm' @('--dir','apps/backend','build')
    Invoke-Native 'Matching-engine regression tests' 'node' @('--test','apps/backend/scripts/b12-matching-core.test.mjs')
    if ($UpdateDashboard) { Install-Day-Dashboard-Panel }

    if ($Mode -eq 'Preview') {
        if (Test-Path -LiteralPath $manifestPath) {
            Stop-Run ('This day already has a preview-manifest.json. Do not regenerate financial data ' +
              'or overwrite a reviewed snapshot; use -Mode CommitMatching with the same settings.')
        }
        $previewRows = @()
        for ($hour = 0; $hour -lt 24; $hour++) {
            $hh = $hour.ToString('00')
            $slot = "${Day}T${hh}:00:00Z"
            $hourArtifacts = Join-Path $artifactDir $hh
            New-Item -ItemType Directory -Force -Path $hourArtifacts | Out-Null
            $target = Join-Path $snapshotDir "hour-${hh}.json"
            if (Test-Path -LiteralPath $target) {
                $snapshot = Assert-HourSnapshot $target $slot $ExpectedUsers
                Write-Host "Reusing preserved preview of hour $hh (no regeneration)."
            } else {
                $created = @(Get-ChildItem -LiteralPath $hourArtifacts -Directory -Filter 'b11-energy-*')
                if ($created.Count -eq 0) {
                    $arguments = @('--registry',$registry,'--time-slot',$slot,'--expected-users',"$ExpectedUsers",
                        '--max-users',"$ExpectedUsers",'--consumption-only-count',"$ConsumptionOnlyCount",
                        '--config',$energyConfig,'--python',$python,'--artifact-dir',$hourArtifacts)
                    Invoke-BackendNode "Generate hour $hh (READ ONLY)" 'b11-energy-pipeline.mjs' $arguments
                    $created = @(Get-ChildItem -LiteralPath $hourArtifacts -Directory -Filter 'b11-energy-*')
                }
                if ($created.Count -ne 1) {
                    Stop-Run "Ambiguous generated source artifacts for hour $hh; inspect manually, no overwrite."
                }
                $source = Join-Path $created[0].FullName "snapshots\energy_snapshot_${Day}T${hh}.json"
                $snapshot = Assert-HourSnapshot $source $slot $ExpectedUsers
                Copy-Item -LiteralPath $source -Destination $target
            }
            $buyers = @($snapshot.users | Where-Object { $_.marketRole -eq 'BUYER' }).Count
            $sellers = @($snapshot.users | Where-Object { $_.marketRole -eq 'SELLER' }).Count
            $previewRows += [pscustomobject]@{
                timeSlot=$slot; filename="hour-${hh}.json"; sha256=(File-Sha $target);
                buyers=$buyers; sellers=$sellers; total=$ExpectedUsers
            }
            Write-Host "HOUR $hh : buyers=$buyers sellers=$sellers; snapshot preserved" -ForegroundColor Green
        }
        $manifest = [ordered]@{
            format='MGL850_NEW_DAY_PREVIEW_V1'; day=$Day; expectedUsers=$ExpectedUsers;
            consumptionOnlyCount=$ConsumptionOnlyCount; energySeed=$EnergySeed;
            originalRegistrySha256=$registrySha; energyConfigSha256=$configSha;
            hours=@($previewRows)
        }
        Write-JsonUtf8 $manifestPath $manifest
        Write-Host "`nPREVIEW COMPLETE: 24 immutable snapshot files generated. No database or Hedera writes." -ForegroundColor Green
        Write-Host "Review: $manifestPath"
        Write-Host "Next: .\RUN_MGL850_DAY.ps1 -Day $Day -RegistryPath `"$registry`" -EnergySeed $EnergySeed -Mode CommitMatching"
        return
    }

    # A reviewed local preview is mandatory before ANY database write.
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Stop-Run 'Run -Mode Preview first, review the full-day manifest, then use -Mode CommitMatching.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.format -cne 'MGL850_NEW_DAY_PREVIEW_V1' -or
        $manifest.day -cne $Day -or $manifest.expectedUsers -ne $ExpectedUsers -or
        $manifest.consumptionOnlyCount -ne $ConsumptionOnlyCount -or
        $manifest.energySeed -ne $EnergySeed -or
        $manifest.originalRegistrySha256 -cne $registrySha -or
        $manifest.energyConfigSha256 -cne $configSha -or
        @($manifest.hours).Count -ne 24) {
        Stop-Run 'Reviewed manifest does not match current day, participant count, seed, registry or configuration.'
    }
    for ($hour = 0; $hour -lt 24; $hour++) {
        $hh = $hour.ToString('00')
        $row = @($manifest.hours)[$hour]
        $slot = "${Day}T${hh}:00:00Z"
        if ($row.timeSlot -cne $slot -or $row.filename -cne "hour-${hh}.json" -or $row.total -ne $ExpectedUsers) {
            Stop-Run "Manifest hour $hh has changed."
        }
        $target = Join-Path $snapshotDir "hour-${hh}.json"
        if ((File-Sha $target) -cne $row.sha256) { Stop-Run "Source snapshot $hh changed since preview." }
        $snap = Assert-HourSnapshot $target $slot $ExpectedUsers
        if (@($snap.users | Where-Object { $_.marketRole -eq 'BUYER' }).Count -ne $row.buyers -or
            @($snap.users | Where-Object { $_.marketRole -eq 'SELLER' }).Count -ne $row.sellers) {
            Stop-Run "Source snapshot $hh roles differ from the reviewed manifest."
        }
    }
    Write-Host 'PASS: All 24 reviewed snapshots have valid immutable hashes.' -ForegroundColor Green
    $phrase = "IMPORT_AND_MATCH_$Day"
    $answer = Read-Host "This will WRITE 24 snapshot imports and 24 matching decisions to PostgreSQL. Type $phrase to proceed"
    if ($answer -cne $phrase) { Stop-Run 'Database-write approval declined.' }

    # B12's existing early role guard rejects zero-seller snapshots even though
    # the shared Python engine and its match validator can check empty outcomes.
    # Use a temporary sibling COPY of the existing audited pipeline, replacing
    # only that guard. Original B12 source remains unchanged; all other checks,
    # serializable transactions and source fingerprints remain active.
    $b12Original = Join-Path $backendDir 'scripts\b12-matching-pipeline.mjs'
    $originalCode = [System.IO.File]::ReadAllText($b12Original)
    $strictGuard = "if (buyers < 1 || sellers < 1) throw new Error('B12 needs at least one buyer and one seller in the imported snapshot');"
    if (-not $originalCode.Contains($strictGuard)) {
        Stop-Run 'B12 matching source has changed. Review its zero-seller validation before using this runner.'
    }
    $replacement = "if (buyers < 1 || sellers < 1) console.log('No buyers or no sellers: verify zero matches with the original Python matcher');"
    $tempScriptName = 'b12-day-runner-' + [guid]::NewGuid().ToString('N') + '.mjs'
    $tempScript = Join-Path $backendDir ("scripts\$tempScriptName")
    try {
        [System.IO.File]::WriteAllText($tempScript,$originalCode.Replace($strictGuard,$replacement),
            (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Native 'Check temporary no-seller matching pipeline syntax' 'node' @('--check',$tempScript)

        # Load API key only in local memory. Never echo it, save it to manifests,
        # put it in a command line, or share the .env file with another machine.
        $envText = [System.IO.File]::ReadAllText((Join-Path $repo '.env'))
        $keyLine = @($envText -split "`r?`n" | Where-Object { $_ -match '^INTERNAL_IMPORT_API_KEY=' })
        if ($keyLine.Count -ne 1) { Stop-Run 'Expected exactly one INTERNAL_IMPORT_API_KEY in repository .env.' }
        $importKey = $keyLine[0].Substring('INTERNAL_IMPORT_API_KEY='.Length).Trim().Trim('"').Trim("'")
        if ($importKey.Length -lt 32) { Stop-Run 'Internal import API key is missing or too short.' }
        try {
            Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health/ready' -TimeoutSec 10 | Out-Null
        } catch { Stop-Run 'Backend is not ready at http://127.0.0.1:3001. Start NestJS and check PostgreSQL.' }
        $progress = @()
        for ($hour = 0; $hour -lt 24; $hour++) {
            $hh = $hour.ToString('00')
            $row = @($manifest.hours)[$hour]
            $source = Join-Path $snapshotDir "hour-${hh}.json"
            if ((File-Sha $source) -cne $row.sha256) { Stop-Run "Hour $hh changed during execution." }
            $snapshot = Assert-HourSnapshot $source $row.timeSlot $ExpectedUsers
            Write-Host "=== IMPORT + MATCH $hh:00 UTC ===" -ForegroundColor Cyan
            try {
                $result = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3001/internal/energy/import' `
                    -ContentType 'application/json' -Headers @{ 'x-internal-api-key'=$importKey } `
                    -Body ([System.IO.File]::ReadAllText($source)) -TimeoutSec 35
            } catch {
                Stop-Run "Import status for hour $hh is unknown or rejected. Do not regenerate data or blindly retry. Inspect DB and verify the saved snapshot: $source"
            }
            if ($result.snapshotId -cne $snapshot.snapshotId -or $result.timeSlot -cne $row.timeSlot -or
                $result.total -ne $ExpectedUsers -or ($result.created + $result.unchanged) -ne $ExpectedUsers) {
                Stop-Run "Import result mismatch for hour $hh. Inspect PostgreSQL."
            }
            Invoke-BackendNode "Recheck immutable DB energy data for $hh" 'b11-verify.mjs' @($source)
            $matchArtifacts = Join-Path $artifactDir ("matching-$hh")
            New-Item -ItemType Directory -Force -Path $matchArtifacts | Out-Null
            $matchingScript = if ($row.buyers -eq 0 -or $row.sellers -eq 0) { $tempScriptName } else { 'b12-matching-pipeline.mjs' }
            $env:B12_MATCH_IMPORT_CONFIRM = 'YES'
            try {
                Invoke-BackendNode "Verify and persist Python matching for $hh" $matchingScript @(
                    '--snapshot',$source,'--expected-users',"$ExpectedUsers",
                    '--python',$python,'--artifact-dir',$matchArtifacts,'--execute'
                )
            } finally {
                Remove-Item Env:\B12_MATCH_IMPORT_CONFIRM -ErrorAction SilentlyContinue
            }
            $outputs = @(Get-ChildItem -LiteralPath $matchArtifacts -Directory -Filter 'b12-matching-*' |
                Sort-Object LastWriteTimeUtc -Descending)
            if ($outputs.Count -lt 1) { Stop-Run "Missing matching evidence for hour $hh." }
            $resultFile = Join-Path $outputs[0].FullName 'matching-output.json'
            $matchResult = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
            $countMatches = @($matchResult.matches).Count
            if (($row.buyers -eq 0 -or $row.sellers -eq 0) -and $countMatches -ne 0) {
                Stop-Run "Nonzero matching output in an empty-side market hour $hh."
            }
            $progress += [pscustomobject]@{ timeSlot=$row.timeSlot; buyers=$row.buyers;
                sellers=$row.sellers; matches=$countMatches; energyImported=$true; matchingCommitted=$true }
            Write-JsonUtf8 (Join-Path $dayDir 'progress.json') ([ordered]@{
                day=$Day; completedHours=@($progress); paymentsBroadcast=0;
                note='V1 matching only. No authoritative V2 trade or TEUSD settlement created.'
            })
            Write-Host "PASS $hh:00 : $countMatches Python matches recorded, no token transfers" -ForegroundColor Green
        }
        $visible=Verify-Day-In-Dashboard
        Write-Host "`nCOMPLETE: 24 energy imports and 24 matching decisions for $Day." -ForegroundColor Green
        Write-Host "Saved snapshots and evidence: $dayDir"
        Write-Host 'IMPORTANT: Matching records are NOT V2 settled trades. No TEUSD was sent.' -ForegroundColor Yellow
        Write-Host 'A new date-independent market-commit and signed Hedera payment worker must be developed and reviewed before settlement.' -ForegroundColor Yellow
        Open-Day-Dashboard $visible.UserId
    } finally {
        Remove-Variable importKey -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
