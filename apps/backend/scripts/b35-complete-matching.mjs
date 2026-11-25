/**
 * B35: finish missing 2026-11-10 matching-run evidence, not blockchain settlement.
 * PREVIEW (default): reads original trusted B11 sources and replays the actual Python greedy matching engine.
 * COMMIT: only matching_runs, after an exact reviewed manifest + confirmation, SERIALIZABLE transaction.
 * No contract imports, wallet signing, TEUSD approvals, V2 market writes, or transactions.
 * Run from repository root with the two existing --env-file options.
 */
import {readFile,readdir,stat,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {importedSnapshotDigest,hashValue,stableMatchingResult} from './b12-matching-core.mjs';
import {sourcePreflight} from './b28-v2-market.mjs';
import {prepareHourly,verifyProposal} from './b22-hourly-core.mjs';
import {B35_DAY,B35_CONFIRM,b35Slots,validateZeroReplay,reviewDigest,assertApprovedReview,verifyExistingRun} from './b35-zero-core.mjs';

const MAX_SOURCE=2*1024*1024, repoRoot=resolve(import.meta.dirname,'../../..');
function options(argv){
 const result={mode:'preview',day:B35_DAY};
 for(const arg of argv){const m=/^--(mode|day|approved|confirm|snapshots|python)=(.+)$/.exec(arg);
  if(!m||Object.hasOwn(result,m[1])&&!(m[1]==='mode'&&result.mode==='preview')&&!(m[1]==='day'&&result.day===B35_DAY))throw Error('Unexpected/duplicate B35 argument');result[m[1]]=m[2];}
 if(!['preview','commit','audit'].includes(result.mode)||result.day!==B35_DAY)throw Error('B35 supports only November 10, 2026');
 if(result.mode==='commit'&&(!result.approved||result.confirm!==B35_CONFIRM))throw Error('Commit requires an approved manifest and exact B35 confirmation');
 if(result.mode!=='commit'&&(result.approved||result.confirm))throw Error('Cannot supply write authorization to read-only mode');
 return result;
}
function dbUrl(){
 const s=process.env.DATABASE_URL;if(!s)throw Error('DATABASE_URL missing');let u;try{u=new URL(s);}catch{throw Error('Invalid DATABASE_URL');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/energy_trading'||decodeURIComponent(u.username)!=='energy_admin'||u.hash)throw Error('B35 accepts local energy_trading/energy_admin only');
 return s;
}
function sha256(buffer){return createHash('sha256').update(buffer).digest('hex');}
async function findB11Sources(dir){
 const dirs=[];
 if(dir){const folder=resolve(dir);if(!existsSync(folder))throw Error('B11 source folder missing');dirs.push(folder);if(existsSync(join(folder,'snapshots')))dirs.push(join(folder,'snapshots'));}
 else for(const e of await readdir(tmpdir(),{withFileTypes:true}))if(e.isDirectory()&&/^b11-energy-/i.test(e.name))dirs.push(join(tmpdir(),e.name,'snapshots'));
 if(dirs.length>200)throw Error('Too many B11 folders');const map=new Map();
 for(const d of dirs){if(!existsSync(d))continue;const entries=await readdir(d,{withFileTypes:true});if(entries.length>1200)throw Error('B11 directory unexpectedly large');
  for(const e of entries){if(!e.isFile()||!/^energy_snapshot.*\.json$/i.test(e.name))continue;
   const file=join(d,e.name);if((await stat(file)).size>MAX_SOURCE)throw Error('B11 file exceeds size guard');
   let src,raw;try{raw=await readFile(file);src=JSON.parse(raw.toString('utf8'));}catch{continue;}
   if(!Array.isArray(src.users)||src.users.length!==12||!b35Slots().includes(src.timeSlot))continue;
   const entry={file,snapshot:src,sourceSha256:sha256(raw),importSha256:importedSnapshotDigest(src)};
   if(!map.has(src.timeSlot))map.set(src.timeSlot,[]);map.get(src.timeSlot).push(entry);
  }
 }
 return map;
}
function trustedOriginal(items,dbImport){
 const matches=items.filter(x=>x.snapshot.snapshotId===dbImport.id&&x.importSha256===dbImport.payload_sha256);
 if(matches.length===0)throw Error('Original B11 source is missing or its fingerprint differs from the PostgreSQL import');
 if(new Set(matches.map(x=>x.sourceSha256)).size!==1)throw Error('Conflicting raw B11 snapshots: manual source review required');
 return matches.sort((a,b)=>a.file.localeCompare(b.file))[0];
}
async function runPythonReplay(prepared,config,python){
 const root=await mkdtemp(join(tmpdir(),'mgl850-b35-python-'));
 try{
  const inputPath=join(root,'input.json'),outputPath=join(root,'output.json'),configPath=join(root,'config.json');
  await writeFile(inputPath,JSON.stringify(prepared.input),{flag:'wx'});
  await writeFile(configPath,JSON.stringify(config),{flag:'wx'});
  const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,PYTHONPATH:[join(repoRoot,'packages/shared/python'),join(repoRoot,'services/matching-engine')].join(delimiter)};
  const p=spawnSync(python,['-m','matching_engine.cli','--input',inputPath,'--config',configPath,'--output',outputPath],{cwd:repoRoot,env,windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
  if(p.error||p.status!==0)throw Error(`Python matching CLI failed. Check .venv dependencies and configuration (exit ${p.status}).`);
  return JSON.parse(await readFile(outputPath,'utf8'));
 }finally{await rm(root,{recursive:true,force:true});}
}
async function dbClient(){const {default:pg}=await import('../node_modules/pg/lib/index.js');return new pg.Client({connectionString:dbUrl(),connectionTimeoutMillis:5000,statement_timeout:60000,query_timeout:65000,application_name:'mgl850-b35-zero-matches'});}
async function checkDbIdentity(db,readonly){
 const {rows:[r]}=await db.query("SELECT current_database() AS db,session_user AS actor,current_setting('transaction_read_only') AS ro");
 if(r?.db!=='energy_trading'||r.actor!=='energy_admin'||r.ro!==(readonly?'on':'off'))throw Error('B35 database identity / transaction mode differs from expected');
}
async function hourState(db,row){
 const [run,match,v2,energy]=await Promise.all([
  db.query('SELECT * FROM matching_runs WHERE time_slot=$1',[row.slot]),
  db.query('SELECT id FROM matches WHERE time_slot=$1',[row.slot]),
  db.query('SELECT id FROM "V2Market" WHERE namespace=\'hourly\' AND mode=\'HOURLY\' AND "intervalStart"=$1',[row.slot]),
  db.query('SELECT user_id,market_role FROM energy_records WHERE snapshot_id=$1',[row.snapshotId]),
 ]);
 if(run.rows.length>1||v2.rows.length!==0||energy.rows.length!==12||new Set(energy.rows.map(x=>x.user_id)).size!==12||
    energy.rows.some(x=>x.market_role==='SELLER')||energy.rows.filter(x=>x.market_role==='BUYER').length!==row.buyers)throw Error(`DB changed or a payable market exists at ${row.slot}`);
 const current=verifyExistingRun(run.rows[0]??null,row,match.rows);
 return current;
}
async function prepareReview(x){
 const folder=await findB11Sources(x.snapshots),cfg=JSON.parse(await readFile(join(repoRoot,'packages/shared/fixtures/matching-config.sample.json'),'utf8'));
 const configSha256=hashValue(cfg);const python=x.python??(existsSync(join(repoRoot,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'))?join(repoRoot,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'):'python');
 const db=await dbClient();let begun=false;const rows=[],sourceSnapshots=new Map();
 try{await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;await checkDbIdentity(db,true);
  // This release only applies to the complete, previously settled B34 demonstration.
  const count=await db.query('SELECT COUNT(*)::int AS c,COUNT(DISTINCT time_slot)::int AS hours FROM energy_snapshot_imports WHERE time_slot>=$1 AND time_slot<$2',[`${x.day}T00:00:00Z`,'2026-11-11T00:00:00Z']);
  const matched=await db.query('SELECT COUNT(*)::int AS c FROM matches WHERE time_slot>=$1 AND time_slot<$2',[`${x.day}T00:00:00Z`,'2026-11-11T00:00:00Z']);
  const runCount=await db.query('SELECT COUNT(*)::int AS c FROM matching_runs WHERE time_slot>=$1 AND time_slot<$2',[`${x.day}T00:00:00Z`,'2026-11-11T00:00:00Z']);
  if(count.rows[0].c!==24||count.rows[0].hours!==24||matched.rows[0].c!==17||![16,24].includes(runCount.rows[0].c))throw Error('Unexpected day baseline: require 24 imports, 17 existing B12 matches, 16 or 24 matching runs');
  const slotList=b35Slots(x.day);
  for(const slot of slotList){
   const imports=(await db.query('SELECT id,payload_sha256 FROM energy_snapshot_imports WHERE time_slot=$1',[slot])).rows;
   if(imports.length!==1)throw Error(`Missing unique trusted import ${slot}`);
   const original=trustedOriginal(folder.get(slot)??[],imports[0]);sourceSnapshots.set(slot,original.snapshot);
   const pre=await sourcePreflight(db,original.snapshot);
   if(pre.slot!==slot||pre.existing.length!==0)throw Error('Source changed or a V2 market already exists');
   const prepared=prepareHourly(original.snapshot,pre.registry,cfg,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:12});
   const output=await runPythonReplay(prepared,cfg,python);
   const plan=verifyProposal(prepared,output); // B05 schema + greedy selection + conservation.
   const stats=validateZeroReplay(prepared.input,output,plan);
   const row={slot,snapshotId:original.snapshot.snapshotId,sourceSha256:original.sourceSha256,importSha256:original.importSha256,configSha256,algorithmVersion:cfg.algorithmVersion,resultSha256:hashValue(stableMatchingResult(output)),buyers:stats.buyers,sellers:stats.sellers,unmatchedBuyers:stats.unmatched,matchCount:0};
   row.existingState=await hourState(db,row);
   rows.push(row);
  }
  await db.query('ROLLBACK');begun=false;
 }finally{if(begun)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});}
 const review={version:'B35_ZERO_MATCH_REPLAY_V1',day:x.day,rows};review.reviewDigest=reviewDigest(review);return {review,sourceSnapshots};
}
async function commit(review,sourceSnapshots){
 const db=await dbClient();let begun=false,created=0,reused=0;
 try{await db.connect();await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');begun=true;await checkDbIdentity(db,false);
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query('SELECT pg_advisory_xact_lock(850,35)');
  for(const row of review.rows){
   // Re-verify the original complete persisted payload under the committing transaction.
   const imp=(await db.query('SELECT id,payload_sha256 FROM energy_snapshot_imports WHERE time_slot=$1',[row.slot])).rows;
   if(imp.length!==1||imp[0].id!==row.snapshotId||imp[0].payload_sha256!==row.importSha256)throw Error('Imported B11 fingerprint changed before commit');
   const original=sourceSnapshots.get(row.slot);if(!original||importedSnapshotDigest(original)!==row.importSha256)throw Error('Original B11 source changed before commit');
   const pre=await sourcePreflight(db,original);
   if(pre.slot!==row.slot||pre.existing.length!==0)throw Error('Trusted B11 source replay changed before commit');
   const state=await hourState(db,row);
   if(state==='IDENTICAL_EXISTING'){reused++;continue;}
   const saved=await db.query('INSERT INTO matching_runs(id,snapshot_id,time_slot,algorithm_version,config_sha256,result_sha256,match_count,unmatched_buyer_count) VALUES ($1,$2,$3,$4,$5,$6,0,$7)',[
    randomUUID(),row.snapshotId,row.slot,row.algorithmVersion,row.configSha256,row.resultSha256,row.unmatchedBuyers]);
   if(saved.rowCount!==1)throw Error('Matching-run insert affected unexpected number of rows');created++;
   if(await hourState(db,row)!=='IDENTICAL_EXISTING')throw Error('Inserted zero-match run did not reconcile');
  }
  const [full,existingMatches,allocations]=await Promise.all([
   db.query('SELECT COUNT(*)::int AS c, COUNT(DISTINCT time_slot)::int AS h FROM matching_runs WHERE time_slot>=$1 AND time_slot<$2',[`${review.day}T00:00:00Z`,'2026-11-11T00:00:00Z']),
   db.query('SELECT COUNT(*)::int AS c FROM matches WHERE time_slot>=$1 AND time_slot<$2',[`${review.day}T00:00:00Z`,'2026-11-11T00:00:00Z']),
   db.query('SELECT COUNT(*)::int AS c,COALESCE(SUM("amountBaseUnits"),0)::text AS total FROM "V2Allocation" a JOIN "V2Market" m ON m.id=a."marketId" WHERE m.namespace=\'hourly\' AND m.mode=\'HOURLY\' AND m."intervalStart">=$1 AND m."intervalStart"<$2',[`${review.day}T00:00:00Z`,'2026-11-11T00:00:00Z']),
  ]);
  if(full.rows[0].c!==24||full.rows[0].h!==24||existingMatches.rows[0].c!==17||allocations.rows[0].c!==17||allocations.rows[0].total!=='1842755')throw Error('B35 full-day invariant failed; all matching-run writes rolled back');
  await db.query('COMMIT');begun=false;console.log(`PASS: B35 single atomic commit created=${created}, identicalReused=${reused}, runHours=24, historicalMatches=17, V2Allocations=17, TEUSDBaseUnits=1842755`);
 }catch(e){if(begun)await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end().catch(()=>{});}
}
async function main(){const x=options(process.argv.slice(2));const {review,sourceSnapshots}=await prepareReview(x);
 console.log('=== B35 EIGHT NO-SELLER HOURS — VERIFIED ORIGINAL B11 + PYTHON REPLAY ===');
 console.table(review.rows.map(r=>({hour:r.slot.slice(11,16),buyers:r.buyers,sellers:r.sellers,matches:r.matchCount,unmatched:r.unmatchedBuyers,sourceHash:r.sourceSha256.slice(0,12),state:r.existingState})));
 console.log('REVIEW DIGEST:',review.reviewDigest);
 if(x.mode==='preview'){
  const path=join(tmpdir(),`MGL850_B35_${x.day}_REVIEW.json`);await writeFile(path,JSON.stringify(review,null,2));
  console.log('REVIEW FILE:',path);console.log('PASS: B35 replay preview complete (READ ONLY). No PostgreSQL writes, no Hedera activity.');return;
 }
 if(x.mode==='audit'){if(review.rows.some(x=>x.existingState!=='IDENTICAL_EXISTING'))throw Error('B35 coverage not committed yet');console.log('PASS: Eight immutable zero-match decisions independently reproduced');return;}
 const approved=JSON.parse(await readFile(resolve(x.approved),'utf8'));assertApprovedReview(approved,review);
 if(process.env.B35_MATCHING_COMMIT_APPROVAL!=='I_APPROVE_B35_MATCHING_ONLY')throw Error('Missing explicit B35_MATCHING_COMMIT_APPROVAL');
 await commit(review,sourceSnapshots);
 console.log('NO TOKEN WRITES: B35 inserted matching_runs only; zero new matches, V2 trades, wallet signatures, or Hedera broadcasts.');
}
main().catch(e=>{const msg=String(e?.message??e);console.error(/postgres(?:ql)?:\/\/|private.?key|password|secret/i.test(msg)?'B35 STOP: sensitive error redacted':`B35 STOP: ${msg}`);process.exitCode=1;});
