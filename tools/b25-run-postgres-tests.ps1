# Read-only B22 source verification using only a newly created disposable database.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$testId=[Guid]::NewGuid().ToString('N')
$testPassword=[Guid]::NewGuid().ToString('N')
$rosterPassword=[Guid]::NewGuid().ToString('N')
$ingestPassword=[Guid]::NewGuid().ToString('N')
$matchPassword=[Guid]::NewGuid().ToString('N')
$approvalPassword=[Guid]::NewGuid().ToString('N')
$evaluationPassword=[Guid]::NewGuid().ToString('N')
$containerName="mgl850-b24bound-test-$testId"
$containerId=$null
$localNode=$null
$priorB25Rpc=$env:B25_LOCAL_RPC_URL
$preflightPassword=[Guid]::NewGuid().ToString('N')
$signerPassword=[Guid]::NewGuid().ToString('N')
$receiptPassword=[Guid]::NewGuid().ToString('N')
$fundingPassword=[Guid]::NewGuid().ToString('N')
$allowancePassword=[Guid]::NewGuid().ToString('N')
$b25Password=[Guid]::NewGuid().ToString('N')
$b25ReporterPassword=[Guid]::NewGuid().ToString('N')
$priorB25Reporter=$env:B25_REPORTER_DATABASE_URL
$b25VerifierPassword=[Guid]::NewGuid().ToString('N')
$priorB25Verifier=$env:B25_VERIFIER_DATABASE_URL
$priorB25=$env:B25_EXECUTOR_DATABASE_URL
$priorAllowance=$env:B24_ALLOWANCE_DATABASE_URL
$priorFunding=$env:B24_FUNDING_DATABASE_URL
$priorReceipt=$env:B24_RECEIPT_DATABASE_URL
$priorSigner=$env:B24_SIGNER_DATABASE_URL
$priorPreflight=$env:B24_PREFLIGHT_DATABASE_URL
$priorA2Test=$env:B24_A2_TEST
$priorDatabaseUrl=$env:DATABASE_URL
$priorTestUrl=$env:B22_TEST_DATABASE_URL
$priorRosterUrl=$env:B22_ROSTER_DATABASE_URL
$priorIngestUrl=$env:B22_INGEST_DATABASE_URL
$priorMatchUrl=$env:B22_MATCH_DATABASE_URL
$priorB24Approver=$env:B24_APPROVER_DATABASE_URL
$priorB24Evaluator=$env:B24_EVALUATOR_DATABASE_URL
function Check-Native { if($LASTEXITCODE -ne 0){throw "Native command failed ($LASTEXITCODE)"} }
try {
 docker image inspect postgres:17 | Out-Null; Check-Native
 $containerId=docker run -d --pull never --name $containerName --label "mgl850.b24bound.disposable=$testId" --network bridge -p '127.0.0.1::5432' -e POSTGRES_USER=b22test -e POSTGRES_DB=b22_disposable_review -e "POSTGRES_PASSWORD=$testPassword" postgres:17; Check-Native
 if($containerId -notmatch '^[0-9a-f]{64}$'){throw 'Invalid container ID'}
 $inspect=(docker inspect $containerId | ConvertFrom-Json)[0]; Check-Native
 if($inspect.Name -ne "/$containerName" -or $inspect.Config.Labels.'mgl850.b24bound.disposable' -ne $testId -or $inspect.Config.Image -ne 'postgres:17'){throw 'Container identity mismatch'}
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
 "CREATE ROLE b24_approver LOGIN PASSWORD '$approvalPassword'; CREATE ROLE b24_evaluator LOGIN PASSWORD '$evaluationPassword'; GRANT USAGE ON SCHEMA b22_guard TO b24_evaluator,b24_approver; GRANT SELECT ON b22_guard.marker TO b24_evaluator,b24_approver; CREATE ROLE b22_roster LOGIN PASSWORD '$rosterPassword'; CREATE ROLE b22_ingest LOGIN PASSWORD '$ingestPassword'; CREATE ROLE b22_match LOGIN PASSWORD '$matchPassword'; GRANT USAGE ON SCHEMA b22_guard TO b22_match; GRANT SELECT ON b22_guard.marker TO b22_match; GRANT USAGE ON SCHEMA b22_guard TO b22_ingest; GRANT SELECT ON b22_guard.marker TO b22_ingest;" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b22a-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b22b-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24a1-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_APPROVER_DATABASE_URL="postgresql://b24_approver:$approvalPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B24_EVALUATOR_DATABASE_URL="postgresql://b24_evaluator:$evaluationPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B22_MATCH_DATABASE_URL="postgresql://b22_match:$matchPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B22_TEST_DATABASE_URL=$env:DATABASE_URL
 $env:B22_ROSTER_DATABASE_URL="postgresql://b22_roster:$rosterPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B22_INGEST_DATABASE_URL="postgresql://b22_ingest:$ingestPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b24_preflight LOGIN PASSWORD '$preflightPassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24a2-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-local-session-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-readiness-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_PREFLIGHT_DATABASE_URL="postgresql://b24_preflight:$preflightPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b24_signer LOGIN PASSWORD '$signerPassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-signing-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_SIGNER_DATABASE_URL="postgresql://b24_signer:$signerPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b24_receipt_verifier LOGIN PASSWORD '$receiptPassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-receipt-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_RECEIPT_DATABASE_URL="postgresql://b24_receipt_verifier:$receiptPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b24_funder LOGIN PASSWORD '$fundingPassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-funding-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_FUNDING_DATABASE_URL="postgresql://b24_funder:$fundingPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b24_allowance LOGIN PASSWORD '$allowancePassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b24-allowance-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B24_ALLOWANCE_DATABASE_URL="postgresql://b24_allowance:$allowancePassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 "CREATE ROLE b25_executor LOGIN PASSWORD '$b25Password'; CREATE ROLE b25_verifier LOGIN PASSWORD '$b25VerifierPassword'; CREATE ROLE b25_reporter LOGIN PASSWORD '$b25ReporterPassword'" | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 Get-Content -Raw -LiteralPath 'tools/b25-runtime-grants.sql' | docker exec -i $containerId psql -q -v ON_ERROR_STOP=1 -U b22test -d b22_disposable_review; Check-Native
 $env:B25_EXECUTOR_DATABASE_URL="postgresql://b25_executor:$b25Password@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B25_REPORTER_DATABASE_URL="postgresql://b25_reporter:$b25ReporterPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B25_VERIFIER_DATABASE_URL="postgresql://b25_verifier:$b25VerifierPassword@127.0.0.1:$($binding.HostPort)/b22_disposable_review?schema=public"
 $env:B24_A2_TEST='1'
 if ($env:B25_PROCESS_CRASH_POINT) {
  $listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
  $listener.Start(); $rpcPort=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  $env:B25_LOCAL_RPC_URL="http://127.0.0.1:$rpcPort"
  $contractsDir=(Resolve-Path 'packages/contracts').Path
  $hardhatCli=(Resolve-Path 'packages/contracts/node_modules/hardhat/dist/src/cli.js').Path
  $localNode=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @("`"$hardhatCli`"",'--config','hardhat.b25.config.ts','node','--hostname','127.0.0.1','--port',"$rpcPort") -WorkingDirectory $contractsDir -WindowStyle Hidden -RedirectStandardOutput 'NUL' -PassThru
  $rpcReady=$false
  for($i=0;$i -lt 60;$i++) { if($localNode.HasExited){throw 'Local Hardhat node exited'}; try {$tcp=[System.Net.Sockets.TcpClient]::new(); $tcp.Connect('127.0.0.1',$rpcPort);$tcp.Dispose();$rpcReady=$true;break}catch{Start-Sleep -Milliseconds 500} }
  if(-not $rpcReady){throw 'Local Hardhat node unavailable'}
 }
 Push-Location packages/contracts
 try { if ($env:B25_PROCESS_CRASH_POINT) { & .\node_modules\.bin\hardhat.cmd --config hardhat.b25.config.ts --network localB25 test --no-compile test/B25SettlementExecution.ts } elseif ($env:B25_TEST_MULTI_ONLY -eq '1') { & .\node_modules\.bin\hardhat.cmd test --no-compile test/B25MultiAllocation.ts } else { & .\node_modules\.bin\hardhat.cmd test --no-compile test/B25SettlementExecution.ts test/B25MultiAllocation.ts }; Check-Native } finally { Pop-Location }
} finally {
 if($localNode -and -not $localNode.HasExited){Stop-Process -Id $localNode.Id -Force}
 $env:B25_LOCAL_RPC_URL=$priorB25Rpc
 $env:B25_REPORTER_DATABASE_URL=$priorB25Reporter
 $env:B25_VERIFIER_DATABASE_URL=$priorB25Verifier
 $env:B25_EXECUTOR_DATABASE_URL=$priorB25
 $env:B24_SIGNER_DATABASE_URL=$priorSigner
 $env:B24_RECEIPT_DATABASE_URL=$priorReceipt
 $env:B24_FUNDING_DATABASE_URL=$priorFunding
 $env:B24_ALLOWANCE_DATABASE_URL=$priorAllowance
 $env:B24_PREFLIGHT_DATABASE_URL=$priorPreflight
 $env:B24_A2_TEST=$priorA2Test
 $env:DATABASE_URL=$priorDatabaseUrl
 $env:B22_TEST_DATABASE_URL=$priorTestUrl
 $env:B22_ROSTER_DATABASE_URL=$priorRosterUrl
 $env:B22_INGEST_DATABASE_URL=$priorIngestUrl
 $env:B22_MATCH_DATABASE_URL=$priorMatchUrl
 $env:B24_APPROVER_DATABASE_URL=$priorB24Approver
 $env:B24_EVALUATOR_DATABASE_URL=$priorB24Evaluator
 if($containerId -and $containerId -match '^[0-9a-f]{64}$'){
  $owned=(docker inspect $containerId | ConvertFrom-Json)[0]
  if($owned.Name -eq "/$containerName" -and $owned.Config.Labels.'mgl850.b24bound.disposable' -eq $testId){docker rm -f -v $containerId | Out-Null}else{Write-Warning 'Container identity changed; refusing cleanup'}
 }
}
