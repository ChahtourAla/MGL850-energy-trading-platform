/**
 * B32 complete 24-hour, read-only readiness and original-B11 replay report.
 * ZERO database writes, wallet reads, token approvals or Hedera broadcasts.
 * No historic B12 match can become payable without original-snapshot replay,
 * explicit V2 authorization and separately reviewed multi-hour settlement code.
 *
 * --day=2026-11-10 [--snapshots=C:\original-b11-artifacts] [--python=C:\...\python.exe]
 */
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {inspectHour,summarizeDay} from './b32-readiness-core.mjs';
import {importedSnapshotDigest} from './b12-matching-core.mjs';

function flags(argv){
 const values={};
 for(const x of argv){
  const m=/^--(day|snapshots|python)=(.+)$/.exec(x);
  if(!m||Object.hasOwn(values,m[1]))throw Error('Accepted: --day=YYYY-MM-DD [--snapshots=original-directory] [--python=interpreter-path]');
  values[m[1]]=m[2];
 }
 if(!/^\d{4}-\d{2}-\d{2}$/.test(values.day??''))throw Error('UTC --day=YYYY-MM-DD required');
 const d=new Date(`${values.day}T00:00:00.000Z`);
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==values.day)throw Error('Invalid UTC date');
 return values;
}
async function findOriginalFiles(given){
 const roots=[];
 if(given){if(!existsSync(given))throw Error('Requested --snapshots directory does not exist');roots.push(resolve(given));}
 else {
  const temp=tmpdir();
  for(const entry of await readdir(temp,{withFileTypes:true}))if(entry.isDirectory()&&/^b11-energy-/i.test(entry.name))roots.push(join(temp,entry.name,'snapshots'));
 }
 const files=[];
 async function inspect(dir,level=0){
  if(!existsSync(dir)||level>3||files.length>500)return;
  let entries=await readdir(dir,{withFileTypes:true});
  if(entries.length>1000)throw Error('Unexpectedly large snapshot folder; choose a smaller --snapshots directory');
  for(const entry of entries){
   const file=join(dir,entry.name);
   if(entry.isFile()&&/\.json$/i.test(entry.name)&&/energy_snapshot|snapshot/i.test(entry.name))files.push(file);
   if(entry.isDirectory()&&level<3&&/^(?:snapshots|b11-energy-|artifacts|original|2026)/i.test(entry.name))await inspect(file,level+1);
  }
 }
 for(const r of roots)await inspect(r);
 const snapshots=new Map();
 for(const file of files){
  let data;try{data=JSON.parse(await readFile(file,'utf8'));}catch{continue;}
  if(typeof data.timeSlot!=='string'||!Array.isArray(data.users)||typeof data.snapshotId!=='string')continue;
  const arr=snapshots.get(data.timeSlot)??[];
  arr.push({file,source:data,digest:importedSnapshotDigest(data)});
  snapshots.set(data.timeSlot,arr);
 }
 return {snapshots,filesExamined:files.length,roots:roots.length};
}
function parseB28Preview(raw){
 const pos=raw.indexOf('{');if(pos<0)throw Error('Missing B28 preview JSON');
 let depth=0,inString=false,escape=false;
 for(let j=pos;j<raw.length;j++){
  const ch=raw[j];
  if(inString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')inString=false;continue;}
  if(ch==='"'){inString=true;continue;}
  if(ch==='{')depth++;
  if(ch==='}'&&--depth===0){const obj=JSON.parse(raw.slice(pos,j+1));if(!obj.readOnlyPreview||!obj.proposalDigest)throw Error('B28 preview did not return a read-only commitment');return obj;}
 }
 throw Error('Truncated B28 preview JSON');
}
export {parseB28Preview};
async function main(){
 const config=flags(process.argv.slice(2));
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL not configured');
 const u=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/energy_trading'||decodeURIComponent(u.username)!=='energy_admin')throw Error('B32 requires local energy_trading/energy_admin read-only connection');
 const original=await findOriginalFiles(config.snapshots);
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:20000,statement_timeout:15000,application_name:'mgl850-b32-full-day-read-only'});
 const rows=[];
 let begun=false;
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const check=(await client.query("SELECT current_database() db,session_user actor,current_setting('transaction_read_only') ro")).rows[0];
  if(check.db!=='energy_trading'||check.actor!=='energy_admin'||check.ro!=='on')throw Error('Wrong database or transaction role');
  for(let h=0;h<24;h++){
   const slot=`${config.day}T${String(h).padStart(2,'0')}:00:00Z`;
   const imports=(await client.query('SELECT id,record_count,schema_version,generator_version,payload_sha256 FROM energy_snapshot_imports WHERE time_slot=$1',[slot])).rows;
   const records=(await client.query('SELECT user_id,snapshot_id,production_wh,consumption_wh,net_energy_wh,market_role,available_energy_wh,required_energy_wh,energy_type,ask_price_microusd_per_kwh,max_price_microusd_per_kwh FROM energy_records WHERE time_slot=$1 ORDER BY user_id',[slot])).rows;
   const matchingRuns=(await client.query('SELECT id,snapshot_id,match_count,algorithm_version FROM matching_runs WHERE time_slot=$1',[slot])).rows;
   const matches=(await client.query('SELECT id,buyer_id,seller_id,quantity_wh,unit_price_microusd_per_kwh,total_amount_microusd,seller_energy_type,status FROM matches WHERE time_slot=$1 ORDER BY id',[slot])).rows;
   const wallets=records.length?(await client.query('SELECT user_id,evm_address FROM wallets WHERE user_id=ANY($1::uuid[])',[records.map(r=>r.user_id)])).rows:[];
   const v2Markets=(await client.query('SELECT id,status FROM "V2Market" WHERE "intervalStart"=$1',[slot])).rows;
   const v2Allocations=v2Markets.length?(await client.query('SELECT id,status FROM "V2Allocation" WHERE "marketId"=ANY($1::text[])',[v2Markets.map(m=>m.id)])).rows:[];
   const r=inspectHour({slot,imports,records,matchingRuns,matches,wallets,v2Markets,v2Allocations});
   r.originalSnapshot='NOT_NEEDED';r.v2Preview=null;
   if(r.state==='ORIGINAL_B11_REPLAY_REQUIRED'){
    const found=original.snapshots.get(slot)??[];
    const valid=found.filter(s=>imports.length===1&&s.source.snapshotId===imports[0].id&&s.source.users.length===12&&s.digest===imports[0].payload_sha256);
    if(valid.length===0){r.originalSnapshot='ORIGINAL_B11_FILE_MISSING_OR_FINGERPRINT_MISMATCH';}
    else if(valid.length>1){r.originalSnapshot='MULTIPLE_ORIGINAL_SOURCES_REQUIRE_REVIEW';}
    else{r.originalSnapshot='PERSISTED_FINGERPRINT_MATCH';r.originalFile=valid[0].file;}
   }
   rows.push(r);
  }
  await client.query('ROLLBACK');begun=false;
 }finally{if(begun)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
 // B28 validation reopens its own guarded READ-ONLY database transaction.
 // Candidate previews are not allowed to commit or create signatures.
 for(const r of rows){
  if(r.originalSnapshot!=='PERSISTED_FINGERPRINT_MATCH')continue;
  const args=['--env-file=.env','--env-file=apps/backend/.env','apps/backend/scripts/b28-v2-market.mjs',`--snapshot=${r.originalFile}`];
  if(config.python)args.push(`--python=${resolve(config.python)}`);
  const run=spawnSync(process.execPath,args,{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:70000,maxBuffer:1024*1024});
  if(run.status!==0){r.originalSnapshot='B28_V2_REPLAY_FAILED';r.replayFailureCode='SOURCE_OR_MATCHING_REPLAY_REJECTED';continue;}
  try{
   const preview=parseB28Preview(run.stdout);
   if(preview.existingV2Market||preview.interval!==r.slot||!preview.readOnlyPreview||preview.allocationCount<1||!/^0x[0-9a-f]{64}$/.test(preview.proposalDigest))throw Error('Unexpected proposal');
   r.v2Preview={marketId:preview.marketId,planId:preview.planId,proposalDigest:preview.proposalDigest,allocationCount:preview.allocationCount,pricingPolicyVersion:preview.pricingPolicyVersion};
   r.originalSnapshot='VERIFIED_B28_READ_ONLY_PREVIEW';
  }catch{r.originalSnapshot='B28_PREVIEW_UNPARSABLE';}
 }
 const summary=summarizeDay(rows);
 const report={mode:'B32_FULL_DAY_READINESS_READ_ONLY',day:config.day,sourceDirectoryScanned:original.roots,sourceFilesExamined:original.filesExamined,...summary,hours:rows,notes:['B12 historical matches are NOT blockchain obligations until independently V2-authorized','All unapproved B12 amounts are provisional only; half-even repricing changes terms','Existing 14:00 V2 settlement is immutable and must not be replayed or re-broadcast','B28 Hedera settlement runner is pinned to one market; future multi-hour payments are intentionally disabled','No database writes, token approvals, wallet decryptions or Hedera transactions performed']};
 console.log('=== B32 FULL-DAY V2 AUTHORIZATION READINESS (READ ONLY) ===');
 console.table(rows.map(r=>({hour:r.slot.slice(11,16),records:r.records,B12:r.legacyMatches,V2:r.v2Allocations,state:r.state,original:r.originalSnapshot,blockers:r.errors.join(',')})));
 console.log('SUMMARY',JSON.stringify({day:config.day,...summary,replayedB28Proposals:rows.filter(r=>r.v2Preview).length,originalSourceFilesExamined:original.filesExamined}));
 const out=join(tmpdir(),`MGL850_B32_${config.day}_READ_ONLY_REPORT.json`);
 await writeFile(out,JSON.stringify(report,null,2),'utf8');
 console.log('REPORT:',out);
 console.log('NO WRITES: No blockchain payments, no market commits, no approvals. Existing 14:00 paid trades untouched.');
}
main().catch(e=>{console.error('B32 READINESS STOP:',String(e?.message??e).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[DATABASE_URL REDACTED]'));process.exitCode=1;});
