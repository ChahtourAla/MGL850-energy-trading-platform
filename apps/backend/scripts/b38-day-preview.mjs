/** B38.1: read-only PostgreSQL + deterministic original Python replay; no RPC or signing. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {slots,sha256,checkManifest,checkParity,review} from './b38-day-core.mjs';
import {sourcePreflight,getReadback} from './b28-v2-market.mjs';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
import {makeB28Proposal,validateCommittedRows} from './b28-v2-core.mjs';
import {approvedMarketView} from './b33-review-core.mjs';
import {b28ProposalDigest} from './b28-commit-approval.mjs';
import {hashValue} from './b12-matching-core.mjs';
const root=resolve(import.meta.dirname,'../../..');
async function main(){
 const args={};for(const x of process.argv.slice(2)){const m=/^--(day|day-dir|python)=(.+)$/.exec(x);if(!m||Object.hasOwn(args,m[1]))throw Error('Expected --day, optional --day-dir and --python');args[m[1]]=m[2];}
 const day=args.day;slots(day);
 const dir=resolve(args['day-dir']??join(process.env.LOCALAPPDATA??'', 'MGL850','simulation-days',day));
 const rawManifest=await readFile(join(dir,'preview-manifest.json'));
 const manifest=JSON.parse(rawManifest.toString('utf8').replace(/^\uFEFF/,''));
 const rows=checkManifest(manifest,day);
 const cfg=JSON.parse(await readFile(join(root,'packages/shared/fixtures/matching-config.sample.json'),'utf8'));
 const configHash=hashValue(cfg);
 const python=args.python??join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const url=new URL(process.env.DATABASE_URL??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/energy_trading'||decodeURIComponent(url.username)!=='energy_admin')throw Error('Unexpected database target');
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:20000,query_timeout:25000});
 const hours=[];let begun=false;
 try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
 const {rows:[identity]}=await db.query("SELECT current_database() AS db,session_user AS actor,current_setting('transaction_read_only') AS ro");
 if(identity.db!=='energy_trading'||identity.actor!=='energy_admin'||identity.ro!=='on')throw Error('Read-only guard failed');
 for(const h of rows){
  const raw=await readFile(join(dir,'snapshots',h.filename));if(sha256(raw)!==h.sha256)throw Error('Snapshot hash mismatch '+h.timeSlot);
  const snapshot=JSON.parse(raw.toString('utf8'));if(snapshot.timeSlot!==h.timeSlot||snapshot.users?.length!==12)throw Error('Snapshot identity mismatch');
  const source=await sourcePreflight(db,snapshot);
  const runs=(await db.query('SELECT * FROM matching_runs WHERE time_slot=$1',[h.timeSlot])).rows;
  const matches=(await db.query('SELECT * FROM matches WHERE time_slot=$1 ORDER BY id',[h.timeSlot])).rows;
  if(runs.length!==1||runs[0].snapshot_id!==snapshot.snapshotId||Number(runs[0].match_count)!==matches.length||runs[0].algorithm_version!==cfg.algorithmVersion||runs[0].config_sha256!==configHash)throw Error('Stored matching run mismatch '+h.timeSlot);
  const legacy=await runHourlyDryRun(snapshot,source.registry,cfg,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:12,python,timeoutMs:45000});
  checkParity(matches,legacy.allocations);
  let market=null;
  if(matches.length){const plan=makeB28Proposal({source,legacy,sourceId:snapshot.snapshotId});checkParity(matches,plan.allocations);market=approvedMarketView({...plan,proposalDigest:b28ProposalDigest(plan)},h.sha256,h.timeSlot);if(source.existing.length)validateCommittedRows(plan,await getReadback(db,plan));}
  else if(source.existing.length)throw Error('Unexpected V2 market in zero-match hour '+h.timeSlot);
  hours.push({slot:h.timeSlot,snapshotId:snapshot.snapshotId,sourceSha256:h.sha256,matchCount:matches.length,market});
  console.log(`PASS ${h.timeSlot}: ${matches.length} matches replayed`);
 }
 await db.query('ROLLBACK');begun=false;
 }finally{if(begun)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});}
 const result=review(day,hours,configHash,sha256(rawManifest));
 const out=join(dir,'b38-v2-preview.json');const text=JSON.stringify(result,null,2)+'\n';
 try{await writeFile(out,text,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||(await readFile(out,'utf8'))!==text)throw Error('Existing B38 preview differs; no overwrite');}
 console.log('SUMMARY',JSON.stringify(result.summary,null,2));console.log('REVIEW DIGEST',result.reviewDigest);console.log('REPORT',out);console.log('PASS: read-only preview; no DB writes or blockchain operations');
}
main().catch(e=>{const s=String(e?.message??e);console.error('B38 STOP:',/postgres(?:ql)?:\/\/|private.?key|password|secret/i.test(s)?'Sensitive details suppressed':s);process.exitCode=1;});
