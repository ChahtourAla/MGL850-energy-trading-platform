# B21 isolated PostgreSQL verification. Runs only with an already local postgres:17 image.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$testId = [Guid]::NewGuid().ToString('N')
$containerName = "mgl850-b21-test-$testId"
$testPassword = [Guid]::NewGuid().ToString('N')
$containerId = $null
$priorDatabaseUrl = $env:DATABASE_URL
$priorB21Url = $env:B21_TEST_DATABASE_URL
$priorCorrectionUrl = $env:B21_CORRECTION_DATABASE_URL
function Check-Native { if ($LASTEXITCODE -ne 0) { throw "Native command failed with exit code $LASTEXITCODE" } }
function Run-SqlFile([string]$database, [string]$path) {
    if ($database -notin @('b21_fresh_review','b21_baseline_review','b21_legacy_final')) { throw 'Refusing unapproved test database' }
    Get-Content -Raw -LiteralPath $path | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b21test -d $database
    Check-Native
}
function Add-Marker([string]$database) {
    if ($database -notin @('b21_fresh_review','b21_baseline_review','b21_legacy_final')) { throw 'Refusing unapproved test database' }
    $sql = "CREATE SCHEMA b21_guard; CREATE TABLE b21_guard.b21_owned_test_marker (marker text PRIMARY KEY); INSERT INTO b21_guard.b21_owned_test_marker VALUES ('mgl850-b21-review-f605e66-20261119'); CREATE TABLE b21_guard.marker (id text PRIMARY KEY); INSERT INTO b21_guard.marker VALUES ('mgl850-b21-correction');"
    $sql | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b21test -d $database
    Check-Native
}
try {
    docker image inspect postgres:17 | Out-Null; Check-Native
    $containerId = docker run -d --pull never --name $containerName --label "mgl850.b21.disposable=$testId" --network bridge -p '127.0.0.1::5432' -e POSTGRES_USER=b21test -e POSTGRES_DB=b21_fresh_review -e "POSTGRES_PASSWORD=$testPassword" postgres:17
    Check-Native
    if ($containerId -notmatch '^[0-9a-f]{64}$') { throw 'Invalid container ID' }
    $inspect = (docker inspect $containerId | ConvertFrom-Json)[0]; Check-Native
    if ($inspect.Name -ne "/$containerName" -or $inspect.Config.Labels.'mgl850.b21.disposable' -ne $testId -or $inspect.Config.Image -ne 'postgres:17') { throw 'Container identity mismatch' }
    if (@($inspect.Mounts | Where-Object { $_.Type -ne 'volume' -or $_.Name -notmatch '^[a-f0-9]{64}$' }).Count) { throw 'Unexpected non-anonymous mount' }
    $binding = $inspect.NetworkSettings.Ports.'5432/tcp'[0]
    if ($binding.HostIp -ne '127.0.0.1' -or $binding.HostPort -notmatch '^\d+$') { throw 'Unexpected port binding' }
    $ready = $false
    for ($i=0; $i -lt 30; $i++) { docker exec $containerId pg_isready -U b21test -d b21_fresh_review *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep -Seconds 1 }
    if (-not $ready) { throw 'Disposable PostgreSQL did not become ready' }
    $identity = docker exec $containerId psql -U b21test -d b21_fresh_review -Atc "SELECT current_database() || ':' || count(*) FROM pg_tables WHERE schemaname='public'"; Check-Native
    if ($identity -ne 'b21_fresh_review:0') { throw 'Fresh test database is not empty' }
    $url = "postgresql://b21test:$testPassword@127.0.0.1:$($binding.HostPort)/b21_fresh_review?schema=public"
    $env:DATABASE_URL=$url
    & .\node_modules\.bin\prisma.cmd migrate deploy --config prisma7.config.ts; Check-Native
    & .\node_modules\.bin\prisma.cmd migrate diff --from-config-datasource --to-schema database/schema.prisma --exit-code --config prisma7.config.ts; Check-Native
    Add-Marker 'b21_fresh_review'
    Run-SqlFile 'b21_fresh_review' 'tools/b21-correction-postgres.sql'
    $env:B21_CORRECTION_DATABASE_URL=$url
    node tools/b21-correction-concurrency.mjs; Check-Native
    .\.venv\Scripts\python.exe tools/b21-postgres-manifest-vectors.py | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b21test -d b21_fresh_review; Check-Native
    docker exec $containerId createdb -U b21test b21_baseline_review; Check-Native
    Get-ChildItem database/migrations -Directory | Where-Object { $_.Name -notmatch 'b21|b22|b24|b25|b26' } | Sort-Object Name | ForEach-Object { Run-SqlFile 'b21_baseline_review' (Join-Path $_.FullName 'migration.sql') }
    Run-SqlFile 'b21_baseline_review' 'database/migrations/20261119000000_b21_v2_market/migration.sql'
    Add-Marker 'b21_baseline_review'
    Run-SqlFile 'b21_baseline_review' 'tools/b21-postgres-safety.sql'
    $env:B21_TEST_DATABASE_URL="postgresql://b21test:$testPassword@127.0.0.1:$($binding.HostPort)/b21_baseline_review?schema=public"
    node tools/b21-postgres-concurrency.mjs; Check-Native
    docker exec $containerId createdb -U b21test b21_legacy_final; Check-Native
    $legacyIdentity = docker exec $containerId psql -U b21test -d b21_legacy_final -Atc "SELECT current_database() || ':' || count(*) FROM pg_tables WHERE schemaname='public'"; Check-Native
    if ($legacyIdentity -ne 'b21_legacy_final:0') { throw 'Legacy test database is not empty' }
    Get-ChildItem database/migrations -Directory | Where-Object { $_.Name -notmatch 'b21|b22|b24|b25|b26' } | Sort-Object Name | ForEach-Object { Run-SqlFile 'b21_legacy_final' (Join-Path $_.FullName 'migration.sql') }
    Add-Marker 'b21_legacy_final'
    Run-SqlFile 'b21_legacy_final' 'tools/b21-legacy-fixture.sql'
    $tables=@('--table=users','--table=wallets','--table=energy_records','--table=matches','--table=trades','--table=b14_transaction_intents','--table=b16_oracle_intents','--table=b17_operator_intents','--table=blockchain_transactions')
    $before=(docker exec $containerId pg_dump -U b21test -d b21_legacy_final --data-only @tables | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n"; Check-Native
    # The database is isolated and already has the exact legacy SQL schema.
    # Record those eight migrations in its own ledger, then deploy all three B21 migrations.
    $env:DATABASE_URL="postgresql://b21test:$testPassword@127.0.0.1:$($binding.HostPort)/b21_legacy_final?schema=public"
    Get-ChildItem database/migrations -Directory | Where-Object { $_.Name -notmatch 'b21|b22|b24|b25|b26' } | Sort-Object Name | ForEach-Object {
        & .\node_modules\.bin\prisma.cmd migrate resolve --applied $_.Name --config prisma7.config.ts; Check-Native
    }
    & .\node_modules\.bin\prisma.cmd migrate deploy --config prisma7.config.ts; Check-Native
    $env:DATABASE_URL=$url
    $after=(docker exec $containerId pg_dump -U b21test -d b21_legacy_final --data-only @tables | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n"; Check-Native
    if ($before -ne $after) { throw 'Legacy data changed during B21 migration' }
    $legacyQuery = 'SELECT (SELECT count(*) FROM users u JOIN wallets w ON w.user_id=u.id JOIN matches m ON m.buyer_id=u.id JOIN trades t ON t.match_id=m.id JOIN b14_transaction_intents b14 ON b14.match_id=m.id JOIN b16_oracle_intents b16 ON b16.match_id=m.id JOIN b17_operator_intents b17 ON b17.match_id=m.id)::text || '':'' || (SELECT count(*) FROM "V2SettlementIntent")::text || '':'' || (SELECT count(*) = 8 FROM pg_indexes WHERE schemaname=''public'' AND indexname IN (''users_email_key'',''wallets_user_id_key'',''energy_records_user_id_time_slot_key'',''matches_pkey'',''trades_match_id_key'',''b14_transaction_intents_match_id_operation_key'',''b16_oracle_intents_match_id_key'',''b17_operator_intents_match_id_operation_key''))::text || '':'' || (SELECT bool_and(convalidated) FROM pg_constraint WHERE connamespace=''public''::regnamespace AND contype=''f'')::text;'
    $legacyResult = $legacyQuery | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b21test -d b21_legacy_final -At; Check-Native
    if ($legacyResult -ne '1:0:true:true') { throw 'Legacy relation read or V2 isolation check failed' }

    Write-Output 'B21 disposable PostgreSQL checks passed; legacy fixture records unchanged.'
} finally {
    $env:DATABASE_URL=$priorDatabaseUrl
    $env:B21_TEST_DATABASE_URL=$priorB21Url
    $env:B21_CORRECTION_DATABASE_URL=$priorCorrectionUrl
    if ($containerId -and $containerId -match '^[0-9a-f]{64}$') {
        $owned = (docker inspect $containerId | ConvertFrom-Json)[0]
        if ($owned.Name -eq "/$containerName" -and $owned.Config.Labels.'mgl850.b21.disposable' -eq $testId) {
            docker rm -f -v $containerId | Out-Null
        } else { Write-Warning 'Container identity changed; refusing cleanup.' }
    }
}
