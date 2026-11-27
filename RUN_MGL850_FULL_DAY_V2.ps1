[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Day,
      [string]$RepositoryPath=(Get-Location).Path,
      [string]$RegistryPath='', [int]$EnergySeed=20271127,
      [switch]$NoBrowser, [switch]$Resume, [ValidateRange(1,10)][int]$MaxGasHBAR=2)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$parsed=[datetime]::MinValue
if (-not [datetime]::TryParseExact($Day,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed) -or $parsed.ToString('yyyy-MM-dd') -cne $Day -or $parsed.AddDays(1) -gt [datetime]::UtcNow.Date) { throw 'A completed UTC calendar date is required.' }
if ($Day -eq '2026-11-10') { throw 'Historical B33 experiment is protected.' }
$repo=(Resolve-Path -LiteralPath $RepositoryPath).Path
$dir=Join-Path $env:LOCALAPPDATA "MGL850\simulation-days\$Day"
$review=Join-Path $dir 'b38-v2-preview.json'
$worker=Join-Path $repo 'apps/backend/scripts/b38-full-settlement-v2.mjs'
$utf8=New-Object System.Text.UTF8Encoding($false)
$source=@'
/** B33 multi-hour Testnet payment worker, pinned to reviewed V2 markets.
 * Default read-only. Never deploys, never signs old 14:00 trades, never
 * retries unknown tx. Requires explicit approvals and existing B28 deployment.
 *
 * --mode=audit|reconcile|settle --approved=... [--confirm=SETTLE_B33_7_MARKETS]
 */
import {readFile,open,mkdir,unlink,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {keccak256,Contract,Transaction} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {TOKEN,CHAIN_ID} from './b28-hedera-core.mjs';
import {SETTLEMENT_ABI,TOKEN_ABI,buyerNonce,domain,TYPES,authorizationDigest,recoverBuyer,rpc,operatorWallet,contractPreflight,simulatedBuyerWallet,signRawTransaction as originalSign,verifyApproval} from './b28-hedera-runtime.mjs';
import {connect,restrictedWrite,addAttempt,updateAttempt,recordReceipt} from './b28-hedera-db.mjs';
import {readApprovedMarket,initialJournal} from './b33-settlement-db.mjs';
import {verifyMarketSettlement,marketTerms,marketPlanCommitment} from './b33-chain-core.mjs';
import {classifyAllocation} from './b33-review-core.mjs';
import {review as buildReview,slots,checkParity} from './b38-day-core.mjs';
const deployment=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b28-hedera','deployment.json');
const hex64=/^0x[0-9a-f]{64}$/;
function args(argv){const o={};for(const a of argv){const m=/^--(mode|approved|confirm)=(.+)$/.exec(a);if(!m||Object.hasOwn(o,m[1]))throw Error('Invalid B38 option');o[m[1]]=m[2];}if(!['audit','reconcile','settle'].includes(o.mode)||!o.approved||!hex64.test(o.confirm??''))throw Error('Expected mode, approved file and review digest');return o;}
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
async function readReview(file,confirm){const r=JSON.parse(await readFile(resolve(file),'utf8'));slots(r.day);if(r.day==='2026-11-10')throw Error('Historical experiment excluded');const expected=buildReview(r.day,r.hours,r.configHash,r.sourceManifestSha256);if(JSON.stringify(r)!==JSON.stringify(expected)||r.reviewDigest!==confirm)throw Error('Review digest mismatch');return {...r,allHours:r.hours,hours:r.hours.filter(h=>h.market).map(h=>h.market)};}
async function signRawTransaction(wallet,fields){const tx=await originalSign(wallet,fields);const parsed=Transaction.from(tx.raw);const ceiling=parsed.gasLimit*(parsed.maxFeePerGas??parsed.gasPrice??0n);const cap=BigInt(process.env.B38_MAX_GAS_HBAR)*10n**18n;const balance=await wallet.provider.getBalance(wallet.address);console.log('GAS BUDGET',JSON.stringify({signer:wallet.address,gasLimit:String(parsed.gasLimit),maximumFeeWei:String(ceiling),capWei:String(cap),balanceWei:String(balance)}));if(ceiling<=0n||ceiling>cap)throw Error('Estimated fee exceeds authorized gas budget or invalid estimate');if(balance<ceiling)throw Error('Insufficient signer HBAR');return tx;}
async function coverage(db,r){const start=new Date(r.day+'T00:00:00Z'),end=new Date(start.getTime()+86400000);const found=(await db.query(`SELECT id FROM "V2Market" WHERE namespace='hourly' AND mode='HOURLY' AND "intervalStart">=$1 AND "intervalStart"<$2 ORDER BY id`,[start,end])).rows.map(x=>x.id);if(JSON.stringify(found)!==JSON.stringify(r.hours.map(h=>h.marketId).sort()))throw Error('Market coverage mismatch');for(const h of r.allHours){const runs=(await db.query('SELECT snapshot_id,match_count FROM matching_runs WHERE time_slot=$1',[h.slot])).rows;const matches=(await db.query('SELECT * FROM matches WHERE time_slot=$1',[h.slot])).rows;if(runs.length!==1||runs[0].snapshot_id!==h.snapshotId||Number(runs[0].match_count)!==h.matchCount)throw Error('Matching coverage mismatch');checkParity(matches,h.market?.allocations.map(a=>({...a,unitPriceMicrousdPerKwh:a.price}))??[]);const n=(await db.query(`SELECT count(*)::int n FROM matches m WHERE m.time_slot=$1 AND (EXISTS (SELECT 1 FROM trades t WHERE t.match_id=m.id) OR EXISTS (SELECT 1 FROM b14_transaction_intents i WHERE i.match_id=m.id) OR EXISTS (SELECT 1 FROM b16_oracle_intents i WHERE i.match_id=m.id) OR EXISTS (SELECT 1 FROM b17_operator_intents i WHERE i.match_id=m.id))`,[h.slot])).rows[0].n;if(n)throw Error('Conflicting legacy activity');}const ids=[...new Set(r.hours.flatMap(h=>h.allocations.flatMap(a=>[a.buyerId,a.sellerId])))];const users=(await db.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND account_origin='SIMULATED'",[ids])).rows;if(users.length!==ids.length)throw Error('Only simulated households may be paid');}
async function verifiedDeployment(provider){
 const d=JSON.parse(await readFile(deployment,'utf8'));
 if(d.state!=='CONFIRMED'||d.chainId!==296||!same(d.token,TOKEN)||!hex64.test(d.deployHash)||!/^0x[0-9a-f]{40}$/i.test(d.contract??''))throw Error('Trusted B28 deployment journal required; never redeploy');
 const receipt=await provider.getTransactionReceipt(d.deployHash);if(!receipt||receipt.status!==1||!same(receipt.contractAddress,d.contract)||!same(receipt.blockHash,d.blockHash))throw Error('Deployment receipt mismatch');
 const block=await provider.getBlock(receipt.blockNumber);if(!block||!same(block.hash,receipt.blockHash))throw Error('Deployment not canonical');
 const checked=await contractPreflight(provider,d.contract,d.operator);if(!same(checked.codeHash,d.codeHash))throw Error('Deployed contract code differs from B28 proof');
 if(process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY&&!same(operatorWallet(provider).address,d.operator))throw Error('Unapproved Hedera settlement operator');
 return {journal:d,...checked};
}
async function view(db,hour,id,keys=false){return readApprovedMarket(db,hour,{allocationId:id,readKey:keys});}
async function status(db,provider,d,hour,alloc){
 const v=await view(db,hour,alloc.id);
 const onchain=await d.settlement.paidAllocations(alloc.id);
 const state=classifyAllocation(v.intent,v.attempts,v.evidence,onchain);
 if(state==='CONFIRMED'){
  const tx=v.attempts.find(a=>a.transactionIdentity==='B28_SETTLEMENT');
  if(!tx||v.evidence[0]?.txHash!==tx.txHash||v.intent.contractAddress?.toLowerCase()!==d.journal.contract.toLowerCase())throw Error('Confirmed journal missing canonical settlement attempt');
  await verifyMarketSettlement(provider,{hash:tx.txHash,contract:d.journal.contract,hour,allocation:v.allocation,expectedDigest:v.intent.id,operator:d.journal.operator});
 }
 else{
  const used=await d.settlement.usedNonces(alloc.buyerAddress,buyerNonce(alloc.id));
  if(used)throw Error('Buyer nonce used on-chain despite no confirmed evidence');
  const onPlan=await d.settlement.marketPlans(hour.marketId);
  if(onPlan!=='0x'+'0'.repeat(64)&&(!same(onPlan,marketPlanCommitment(hour))||!same(await d.settlement.marketSnapshots(hour.marketId),hour.snapshotHash)))throw Error('Conflicting market commitment on-chain');
  if(state==='RESUME_AFTER_APPROVAL'){
   const ap=v.attempts[0];await verifyApproval(provider,ap.txHash,alloc.buyerAddress,d.journal.contract,alloc.amountBaseUnits);
   if(!ap.recoveryMetadata?.deadline||BigInt(ap.recoveryMetadata.deadline)<=BigInt(Math.floor(Date.now()/1000)+90))throw Error('Previous approval has expired authorization; manual recovery required');
  }
  if(await d.token.balanceOf(alloc.buyerAddress)<BigInt(alloc.amountBaseUnits)||await provider.getBalance(alloc.buyerAddress)<=0n)throw Error('Buyer has insufficient TEUSD/HBAR');
 }
 return {view:v,state,txHash:v.evidence[0]?.txHash??null};
}
async function audit(db,provider,d,review){const all=[];
 for(const h of review.hours){for(const a of h.allocations){const x=await status(db,provider,d,h,a);all.push({hour:h.slot,allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,amountBaseUnits:a.amountBaseUnits,state:x.state,transactionHash:x.txHash});}}
 console.table(all.map(x=>({hour:x.hour.slice(11,16),allocation:x.allocationId.slice(0,12),baseUnits:x.amountBaseUnits,status:x.state,tx:x.transactionHash??''})));
 console.log('SUMMARY',JSON.stringify({mode:'B33_SEVEN_MARKETS_READ_ONLY',markets:review.hours.length,allocations:all.length,confirmed:all.filter(x=>x.state==='CONFIRMED').length,eligible:all.filter(x=>x.state==='ELIGIBLE').length,resume:all.filter(x=>x.state==='RESUME_AFTER_APPROVAL').length,baseUnits:all.reduce((a,b)=>a+BigInt(b.amountBaseUnits),0n).toString(),noBlockchainWrites:true}));return all;
}
async function recordAndBroadcast(db,provider,{settlementId,attempt,raw,hash,stage}){
 // Only broadcast after the exact signed hash is durable in PostgreSQL.
 const sent=await provider.broadcastTransaction(raw);if(!same(sent.hash,hash))throw Error('Provider returned a different transaction hash');
 await updateAttempt(db,{id:attempt.id,status:'SUBMITTED',intentStatus:stage==='settlement'?'SUBMITTED':undefined});
 const r=await provider.waitForTransaction(hash,1,120000);
 if(!r||r.status!==1)throw Error('Unknown/reverted transaction outcome; use B33 reconcile, NEVER resubmit');return r;
}
async function completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,approvalJournaled){
 const contract=d.journal.contract,nonce=buyerNonce(a.id);
 if(await d.settlement.paidAllocations(a.id)||await d.settlement.usedNonces(a.buyerAddress,nonce))throw Error('Already paid on-chain; reconcile and stop');
 if(await d.token.allowance(a.buyerAddress,contract)<BigInt(a.amountBaseUnits))throw Error('Insufficient token approval');
 await d.settlement.connect(operator).settle.staticCall(terms,signature);
 const tx=await signRawTransaction(operator,{to:contract,data:d.settlement.interface.encodeFunctionData('settle',[terms,signature])});
 const attempt=approvalJournaled
  ?await addAttempt(db,{settlementId:digest,txHash:tx.hash,nonce:tx.nonce,metadata:{kind:'settlement',deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}})
  :await initialJournal(db,{settlementId:digest,a:v.allocation,contract,token:TOKEN,hash:tx.hash,nonce:tx.nonce,kind:'B28_SETTLEMENT',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}});
 console.log('B33 signed settlement HASH journaled:',tx.hash);
 await recordAndBroadcast(db,provider,{settlementId:digest,attempt,raw:tx.raw,hash:tx.hash,stage:'settlement'});
 const proof=await verifyMarketSettlement(provider,{hash:tx.hash,contract,hour:h,allocation:v.allocation,expectedDigest:digest,operator:operator.address});
 await recordReceipt(db,{settlementId:digest,attemptId:attempt.id,txHash:tx.hash,blockHash:proof.blockHash,logIndex:proof.settlementLogIndex,allocation:v.allocation,contract,token:TOKEN});
 console.log('PASS: B33 onchain and database payment confirmed:',a.id,tx.hash);
}
async function settleOne(db,provider,d,h,allocation,prior){
 const a=allocation,contract=d.journal.contract;
 const v=await view(db,h,a.id,true),operator=operatorWallet(provider),buyer=await simulatedBuyerWallet(v.buyerWallet,provider);
 if(!same(buyer.address,a.buyerAddress)||!same(operator.address,d.journal.operator))throw Error('Private signing wallet identity mismatch');
 let deadline,previouslyApproved=prior.state==='RESUME_AFTER_APPROVAL';
 if(previouslyApproved){
  if(v.intent?.status!=='READY'||v.attempts.length!==1||v.attempts[0].status!=='CONFIRMED'||v.attempts[0].transactionIdentity!=='B28_APPROVAL')throw Error('Unrecognized approval journal');
  deadline=BigInt(v.attempts[0].recoveryMetadata?.deadline);
  await verifyApproval(provider,v.attempts[0].txHash,buyer.address,contract,a.amountBaseUnits);
 }else{
  if(v.intent||v.attempts.length||v.evidence.length)throw Error('Prior journal activity: stop');
  deadline=BigInt(Math.floor(Date.now()/1000)+3600);
 }
 const terms=marketTerms(h,v.allocation,buyerNonce(a.id),deadline);
 const digest=authorizationDigest(terms,contract),signature=await buyer.signTypedData(domain(contract),TYPES,terms);
 if(!recoverBuyer(terms,contract,signature)||!same(await d.settlement.settlementId(terms),digest))throw Error('EIP712 buyer signature mismatch');
 if(previouslyApproved){await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,true);return;}
 const allowance=await d.token.allowance(a.buyerAddress,contract);
 if(allowance<BigInt(a.amountBaseUnits)){
  const tx=await signRawTransaction(buyer,{to:TOKEN,data:d.token.interface.encodeFunctionData('approve',[contract,BigInt(a.amountBaseUnits)])});
  const ap=await initialJournal(db,{settlementId:digest,a:v.allocation,contract,token:TOKEN,hash:tx.hash,nonce:tx.nonce,kind:'B28_APPROVAL',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString(),approvalAmount:String(a.amountBaseUnits)}});
  console.log('B33 signed buyer APPROVAL journaled:',tx.hash);
  await recordAndBroadcast(db,provider,{settlementId:digest,attempt:ap,raw:tx.raw,hash:tx.hash,stage:'approval'});
  await verifyApproval(provider,tx.hash,buyer.address,contract,a.amountBaseUnits);
  await updateAttempt(db,{id:ap.id,status:'CONFIRMED',intentStatus:'READY'});
  console.log('PASS: B33 buyer approval confirmed:',tx.hash);
  await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,true);return;
 }
 await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,false);
}
async function reconcileKnown(db,provider,d,review){
 for(const h of review.hours){for(const a of h.allocations){
  const v=await view(db,h,a.id);
  if(!v.intent)continue;
  if(!same(v.intent.contractAddress,d.journal.contract))throw Error('Recorded settlement has different contract');
  const ap=v.attempts.find(x=>x.transactionIdentity==='B28_APPROVAL');
  const tx=v.attempts.find(x=>x.transactionIdentity==='B28_SETTLEMENT');
  if(ap&&ap.status!=='CONFIRMED'){
   const receipt=await provider.getTransactionReceipt(ap.txHash);
   if(!receipt)throw Error(`APPROVAL OUTCOME UNKNOWN: ${ap.txHash}. Do not retry.`);
   if(receipt.status!==1)throw Error(`Approval reverted: ${ap.txHash}. Manual recovery required.`);
   await verifyApproval(provider,ap.txHash,a.buyerAddress,d.journal.contract,a.amountBaseUnits);
   await updateAttempt(db,{id:ap.id,status:'CONFIRMED',intentStatus:'READY'});
  }
  if(tx){
   const receipt=await provider.getTransactionReceipt(tx.txHash);
   if(!receipt)throw Error(`SETTLEMENT OUTCOME UNKNOWN: ${tx.txHash}. Do not resubmit.`);
   if(receipt.status!==1)throw Error(`Settlement reverted: ${tx.txHash}. Manual recovery required.`);
   const proof=await verifyMarketSettlement(provider,{hash:tx.txHash,contract:d.journal.contract,hour:h,allocation:v.allocation,expectedDigest:v.intent.id,operator:d.journal.operator});
   if(v.intent.status==='CONFIRMED'){if(v.evidence.length!==1||v.evidence[0].txHash!==tx.txHash)throw Error('Conflicting confirmed evidence');}
   else{if(v.evidence.length)throw Error('Conflicting prior proof');await recordReceipt(db,{settlementId:v.intent.id,attemptId:tx.id,txHash:tx.txHash,blockHash:proof.blockHash,logIndex:proof.settlementLogIndex,allocation:v.allocation,contract:d.journal.contract,token:TOKEN});}
  }
 }}
}
async function lock(reviewDay){const file=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b33','full-day-payment.lock');await mkdir(dirname(file),{recursive:true});const f=await open(file,'wx',0o600);await f.writeFile(JSON.stringify({pid:process.pid,day:reviewDay,createdAt:new Date().toISOString()}));return {f,file};}
async function main(){const x=args(process.argv.slice(2)),review=await readReview(x.approved,x.confirm);
 const db=await connect();let guard=null,done=false,provider;
 try{provider=await rpc();const d=await verifiedDeployment(provider);await coverage(db,review);
  if(x.mode==='audit'){await audit(db,provider,d,review);return;}
  if(x.mode==='reconcile'){await reconcileKnown(db,provider,d,review);await audit(db,provider,d,review);console.log('PASS: Known journal transactions independently reconciled; no broadcasts');return;}
  if(process.env.B28_ENABLE_TESTNET_BROADCAST!=='I_ACCEPT_TESTNET_TRANSACTION_COSTS'||process.env.B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING!=='YES'||!process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY||!process.env.WALLET_ENCRYPTION_KEY_B64)throw Error('Explicit testnet/custodial authorization, operator key, wallet encryption key required');
  const operator=operatorWallet(provider);if(!same(operator.address,d.journal.operator)||await provider.getBalance(operator.address)<=0n)throw Error('Unfunded/wrong operator');
  guard=await lock(review.day);
  // DO NOT reconcile implicitly during live sends: unknown receipts require independent review.
  const first=await audit(db,provider,d,review);
  const requirements=new Map();for(const a of first.filter(a=>a.state!=='CONFIRMED'))requirements.set(a.buyer,(requirements.get(a.buyer)??0n)+BigInt(a.amountBaseUnits));for(const [buyer,amount] of requirements){if(await d.token.balanceOf(buyer)<amount)throw Error('TEUSD shortfall: funding not authorized by this runner');}
  console.log(`B33: ${first.filter(x=>x.state==='CONFIRMED').length} already confirmed, ${first.filter(x=>x.state!=='CONFIRMED').length} remaining. No redeploy.`);
  for(const h of review.hours){for(const a of h.allocations){
   const current=await status(db,provider,d,h,a);
   if(current.state==='CONFIRMED'){console.log('SKIP: Already independently confirmed',a.id);continue;}
   console.log('B33 settle:',h.slot,a.id,a.amountBaseUnits);
   await settleOne(db,provider,d,h,a,current);
   const checked=await status(db,provider,d,h,a);if(checked.state!=='CONFIRMED')throw Error('Settlement did not independently confirm; stop before next payment');
  }}
  const final=await audit(db,provider,d,review);if(final.some(x=>x.state!=='CONFIRMED'))throw Error('Missing final verified payment');
  await coverage(db,review);if(final.length!==review.summary.allocations||final.reduce((n,a)=>n+BigInt(a.amountBaseUnits),0n)!==BigInt(review.summary.totalBaseUnits))throw Error('Final payment coverage mismatch');await writeFile(join(dirname(resolve(x.approved)),'b38-full-settlement-audit.json'),JSON.stringify({day:review.day,reviewDigest:review.reviewDigest,chainId:296,confirmed:final.length,totalBaseUnits:review.summary.totalBaseUnits,payments:final},null,2)+'\n');done=true;console.log('PASS: All approved daily payments verified on Hedera and PostgreSQL.');
 }finally{provider?.destroy();await db.end().catch(()=>{});if(guard){await guard.f.close().catch(()=>{});if(done)await unlink(guard.file).catch(()=>{});else console.error('B38 FULL HALT: lock preserved for recovery. Never rerun blindly:',guard.file);}}
}
main().catch(e=>{const s=String(e?.message??e);console.error(/private.?key|postgres(?:ql)?:\/\/|password|secret/i.test(s)?'B38 FULL STOP: sensitive error redacted':`B38 FULL STOP: ${s}`);console.error('If ANY signed hash exists, inspect and reconcile the journal before any further settlement. Never remove the lock blindly.');process.exitCode=1;});
'@
function Run-Node([string[]]$Arguments) {
    & node @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Node worker stopped ($LASTEXITCODE). Preserve all journals and artifacts." }
}
function Wait-Http([string]$Url,[int]$Attempts) {
    for($i=0;$i -lt $Attempts;$i++) {
        try { $r=Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4; if($r.StatusCode -eq 200){return $true} } catch {}
        Start-Sleep -Seconds 2
    }
    return $false
}
Push-Location $repo
try {
    foreach($f in @('RUN_MGL850_DAY.ps1','.env','apps/backend/.env','apps/backend/scripts/b38-day-preview.mjs','apps/backend/scripts/b38-day-commit.mjs','apps/backend/scripts/b38-day-core.test.mjs','apps/backend/scripts/b38-commit-core.test.mjs','apps/backend/scripts/b33-settlement-db.mjs','apps/backend/scripts/b33-chain-core.mjs','apps/backend/scripts/b28-hedera-runtime.mjs')) {
        if(-not (Test-Path -LiteralPath $f -PathType Leaf)){throw "Missing prerequisite: $f"}
    }
    if(Test-Path -LiteralPath $worker){
        if(([IO.File]::ReadAllText($worker)).Trim() -cne $source.Trim()){throw 'Existing B38 full worker differs; review it rather than overwrite.'}
    } else {[IO.File]::WriteAllText($worker,$source,$utf8)}
    Run-Node @('--check',$worker)
    Run-Node @('--test','apps/backend/scripts/b38-day-core.test.mjs','apps/backend/scripts/b38-commit-core.test.mjs')
    if(-not (Wait-Http 'http://127.0.0.1:3001/health/ready' 1)){
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k','pnpm --dir apps/backend start:dev') -WorkingDirectory $repo
        if(-not (Wait-Http 'http://127.0.0.1:3001/health/ready' 30)){throw 'Backend not ready; check local PostgreSQL and NestJS.'}
    }
    if(-not (Test-Path -LiteralPath $review)){
        if(-not $RegistryPath){$RegistryPath=Join-Path $repo 'services/data-generator/output/user-registry.generated.json'}
        $legacy=Join-Path $repo 'RUN_MGL850_DAY.ps1'
        $common=@{Day=$Day;RegistryPath=$RegistryPath;EnergySeed=$EnergySeed;RepositoryPath=$repo;NoBrowser=$true;NoFrontendAutoStart=$true}
        if(-not (Test-Path -LiteralPath (Join-Path $dir 'preview-manifest.json'))){& $legacy @common -Mode Preview}
        $progress=Join-Path $dir 'progress.json';$complete=$false
        if(Test-Path -LiteralPath $progress){$p=Get-Content -LiteralPath $progress -Raw|ConvertFrom-Json;$complete=(@($p.completedHours).Count -eq 24 -and @($p.completedHours|Where-Object{-not $_.energyImported -or -not $_.matchingCommitted}).Count -eq 0)}
        if(-not $complete){& $legacy @common -Mode CommitMatching -UpdateDashboard}
    }
    $nodeEnv=@('--env-file=.env','--env-file=apps/backend/.env')
    Run-Node ($nodeEnv+@('apps/backend/scripts/b38-day-preview.mjs',"--day=$Day"))
    $r=Get-Content -LiteralPath $review -Raw|ConvertFrom-Json
    $digest=[string]$r.reviewDigest
    if($digest -cnotmatch '^0x[0-9a-f]{64}$' -or $r.day -cne $Day){throw 'Invalid reviewed digest'}
    Write-Host "Reviewed day: $Day | allocations: $($r.summary.allocations) | TEUSD base units: $($r.summary.totalBaseUnits)"
    Write-Host "Review manifest: $review"
    $r.summary | ConvertTo-Json -Depth 6 | Write-Host
    $phrase="SETTLE_TESTNET_$Day"
    if((Read-Host "Authorize reviewed market persistence and simulated-wallet Testnet payments (max $MaxGasHBAR HBAR gas ceiling per transaction; no minting). Type $phrase") -cne $phrase){throw 'Approval declined'}
    Run-Node ($nodeEnv+@('apps/backend/scripts/b38-day-commit.mjs',"--day=$Day",'--mode=commit',"--confirm=$digest"))
    $oldGas=$env:B38_MAX_GAS_HBAR; $oldBroadcast=$env:B28_ENABLE_TESTNET_BROADCAST; $oldCustody=$env:B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING
    try {
        $env:B28_ENABLE_TESTNET_BROADCAST='I_ACCEPT_TESTNET_TRANSACTION_COSTS'
        $env:B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING='YES'
        $env:B38_MAX_GAS_HBAR=[string]$MaxGasHBAR
        if($Resume){
            $lock=Join-Path $env:LOCALAPPDATA 'mgl850-b33\full-day-payment.lock'
            if(Test-Path -LiteralPath $lock){
                $lockText=[IO.File]::ReadAllText($lock)
                $prior=$lockText|ConvertFrom-Json
                if($prior.day -cne $Day){throw 'Recovery lock belongs to a different day'}
                if(Get-Process -Id ([int]$prior.pid) -ErrorAction SilentlyContinue){throw 'Prior lock PID is active; stop and investigate'}
                Run-Node ($nodeEnv+@($worker,'--mode=reconcile',"--approved=$review","--confirm=$digest"))
                if([IO.File]::ReadAllText($lock) -cne $lockText){throw 'Recovery lock changed during reconciliation'}
                $archive="$lock.reconciled.$([guid]::NewGuid().ToString('N'))"
                Move-Item -LiteralPath $lock -Destination $archive
                Write-Host "Reconciled lock archived: $archive"
            } else { Run-Node ($nodeEnv+@($worker,'--mode=reconcile',"--approved=$review","--confirm=$digest")) }
        }
        Run-Node ($nodeEnv+@($worker,'--mode=settle',"--approved=$review","--confirm=$digest"))
    } finally {
        $env:B38_MAX_GAS_HBAR=$oldGas
        $env:B28_ENABLE_TESTNET_BROADCAST=$oldBroadcast
        $env:B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING=$oldCustody
    }
    $audit=Get-Content -LiteralPath (Join-Path $dir 'b38-full-settlement-audit.json') -Raw|ConvertFrom-Json
    if($audit.day -cne $Day -or $audit.reviewDigest -cne $digest -or $audit.confirmed -ne $r.summary.allocations -or $audit.totalBaseUnits -cne $r.summary.totalBaseUnits){throw 'Settlement audit mismatch'}
    $keyLines=@([IO.File]::ReadAllLines((Join-Path $repo '.env'))|Where-Object{$_ -match '^TRADING_API_READ_ADMIN_KEY='})
    if($keyLines.Count -ne 1){throw 'Missing dashboard read key; payments may already be confirmed.'}
    $key=$keyLines[0].Substring('TRADING_API_READ_ADMIN_KEY='.Length).Trim().Trim('"').Trim("'")
    $coverage=Invoke-RestMethod -Uri "http://127.0.0.1:3001/internal/v2/demo/day-coverage?day=$Day" -Headers @{'x-trading-read-key'=$key} -TimeoutSec 30
    if($coverage.utcDay -cne $Day -or $coverage.summary.importedHours -ne 24 -or $coverage.summary.b12RunHours -ne 24 -or $coverage.summary.b12Matches -ne $audit.confirmed -or $coverage.summary.v2Allocations -ne $audit.confirmed -or $coverage.summary.recordedProofs -ne $audit.confirmed){throw 'Dashboard coverage mismatch; do not repeat payments.'}
    $users=Invoke-RestMethod -Uri 'http://127.0.0.1:3001/internal/v2/demo/users' -Headers @{'x-trading-read-key'=$key} -TimeoutSec 30
    if(@($users.users).Count -ne 12){throw 'Unexpected dashboard household count'}
    $url="http://localhost:3000/?day=$Day&userId=$($users.users[0].userId)"
    Write-Host "PAYMENTS VERIFIED: $($audit.confirmed) | base units $($audit.totalBaseUnits)" -ForegroundColor Green
    Write-Host "Evidence: $dir\b38-full-settlement-audit.json"
    if(-not $NoBrowser){
        if(-not (Wait-Http 'http://127.0.0.1:3000/' 1)){Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k','pnpm --dir apps/frontend dev') -WorkingDirectory $repo}
        if(Wait-Http 'http://127.0.0.1:3000/' 30){Start-Process $url}else{Write-Warning 'Payments verified, but frontend did not start.'}
    }
    Write-Host "Dashboard: $url"
} finally {Pop-Location}
