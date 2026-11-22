# Read-only B22 source verification using only a newly created disposable database.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$testId=[Guid]::NewGuid().ToString('N')
$testPassword=[Guid]::NewGuid().ToString('N')
$rosterPassword=[Guid]::NewGuid().ToString('N')
$ingestPassword=[Guid]::NewGuid().ToString('N')
$matchPassword=[Guid]::NewGuid().ToString('N')
$b26Password=[Guid]::NewGuid().ToString('N')
$containerName="mgl850-b22-test-$testId"
$containerId=$null
$priorDatabaseUrl=$env:DATABASE_URL
$priorTestUrl=$env:B22_TEST_DATABASE_URL
$priorRosterUrl=$env:B22_ROSTER_DATABASE_URL
$priorIngestUrl=$env:B22_INGEST_DATABASE_URL
$priorMatchUrl=$env:B22_MATCH_DATABASE_URL
function Check-Native { if($LASTEXITCODE -ne 0){throw "Native command failed ($LASTEXITCODE)"} }
try {
 docker image inspect postgres:17 | Out-Null; Check-Native
 $containerId=docker run -d --pull never --name $containerName --label "mgl850.b22.disposable=$testId" --network bridge -p '127.0.0.1::5432' -e POSTGRES_USER=b22test -e POSTGRES_DB=b22_disposable_review -e "POSTGRES_PASSWORD=$testPassword" postgres:17; Check-Native
 if($containerId -notmatch '^[0-9a-f]{64}$'){throw 'Invalid container ID'}
 $inspect=(docker inspect $containerId | ConvertFrom-Json)[0]; Check-Native
 if($inspect.Name -ne "/$containerName" -or $inspect.Config.Labels.'mgl850.b22.disposable' -ne $testId -or $inspect.Config.Image -ne 'postgres:17'){throw 'Container identity mismatch'}
 if(@($inspect.Mounts | Where-Object { $_.Type -ne 'volume' -or $_.Name -notmatch '^[a-f0-9]{64}$' }).Count){throw 'Unexpected mount'}
 $binding=$inspect.NetworkSettings.Ports.'5432/tcp'[0]
 if($binding.HostIp -ne '127.0.0.1' -or $binding.HostPort -notmatch '^\d+$'){throw 'Unexpected port binding'}
 $ready=$false
 for($i=0;$i -lt 30;$i++){docker exec $containerId pg_isready -h 127.0.0.1 -U b22test -d b22_disposable_review *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Disposable database unavailable'}
 $identity=docker exec $containerId psql -U b22test -d b22_disposable_review -Atc "SELECT current_database() || ':' || count(*) FROM pg_tables WHERE schemaname='public'"; Check-Native
 if($identity -ne 'b22_disposable_review:0'){throw 'Database not empty'}
 $env:DATABASE_URL="postgresql://b22test:$testPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 & .\node_modules\.bin\prisma.cmd migrate deploy --config prisma7.config.ts; Check-Native
 "CREATE SCHEMA b22_guard; CREATE TABLE b22_guard.marker(value text PRIMARY KEY); INSERT INTO b22_guard.marker VALUES ('b22-isolated-test-only');" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 "CREATE ROLE b22_roster LOGIN PASSWORD '$rosterPassword'; CREATE ROLE b22_ingest LOGIN PASSWORD '$ingestPassword'; CREATE ROLE b22_match LOGIN PASSWORD '$matchPassword'; GRANT USAGE ON SCHEMA b22_guard TO b22_match; GRANT SELECT ON b22_guard.marker TO b22_match; GRANT USAGE ON SCHEMA b22_guard TO b22_ingest; GRANT SELECT ON b22_guard.marker TO b22_ingest;" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b22a-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b22b-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B22_MATCH_DATABASE_URL="postgresql://b22_match:$matchPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B22_TEST_DATABASE_URL=$env:DATABASE_URL
 $env:B22_ROSTER_DATABASE_URL="postgresql://b22_roster:$rosterPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B22_INGEST_DATABASE_URL="postgresql://b22_ingest:$ingestPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b26_worker LOGIN PASSWORD '$b26Password'; CREATE ROLE b26_reporter LOGIN PASSWORD '$b26Password'; CREATE ROLE b26_admin LOGIN PASSWORD '$b26Password';" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b26-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B26_WORKER_DATABASE_URL="postgresql://b26_worker:$b26Password@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 node tools/b26-postgres.mjs; Check-Native
 node tools/b22-registry-postgres.mjs; Check-Native
 node tools/b22a-postgres.mjs; Check-Native
 node tools/b22b-postgres.mjs; Check-Native
 node tools/b26-b22-postgres.mjs; Check-Native
} finally {
 Remove-Item Env:B26_WORKER_DATABASE_URL -ErrorAction SilentlyContinue
 $env:DATABASE_URL=$priorDatabaseUrl
 $env:B22_TEST_DATABASE_URL=$priorTestUrl
 $env:B22_ROSTER_DATABASE_URL=$priorRosterUrl
 $env:B22_INGEST_DATABASE_URL=$priorIngestUrl
 $env:B22_MATCH_DATABASE_URL=$priorMatchUrl
 if($containerId -and $containerId -match '^[0-9a-f]{64}$'){
  $owned=(docker inspect $containerId | ConvertFrom-Json)[0]
  if($owned.Name -eq "/$containerName" -and $owned.Config.Labels.'mgl850.b22.disposable' -eq $testId){docker rm -f -v $containerId | Out-Null}else{Write-Warning 'Container identity changed; refusing cleanup'}
 }
}
