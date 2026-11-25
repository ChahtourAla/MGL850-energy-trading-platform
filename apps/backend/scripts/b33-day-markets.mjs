/** B33: deterministic full-day preview and explicit V2 commit of seven additional hours.
 * No Hedera calls or wallet private keys. Never writes without B28's existing
 * restricted writer and all exact SHA256/market/plan/proposal confirmations.
 *
 * --mode=preview --day=2026-11-10 [--snapshots=...] [--python=...]
 * --mode=commit --day=2026-11-10 --approved=PATH --confirm=APPROVE_B33_7_MARKETS
 */
import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {importedSnapshotDigest,hashValue} from './b12-matching-core.mjs';
import {sourcePreflight,getReadback} from './b28-v2-market.mjs';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
import {makeB28Proposal,buildB28Statements,validateCommittedRows} from './b28-v2-core.mjs';
import {assertSafeRole,assertWriterIdentity,migrationMatches} from './b28-one-step-core.mjs';
import {b28ProposalDigest} from './b28-commit-approval.mjs';
import {approvedMarketView,buildReview,assertApprovedFile,OTHER_HOURS} from './b33-review-core.mjs';
const MAX_SIZE=2*1024*1024;
function args(argv){const x={};for(const a of argv){const m=/^--(mode|day|snapshots|python|approved|confirm)=(.+)$/.exec(a);if(!m||Object.hasOwn(x,m[1]))throw Error('Invalid/duplicate B33 argument');x[m[1]]=m[2];}
 if(!['preview','commit','audit'].includes(x.mode)||!/^\d{4}-\d{2}-\d{2}$/.test(x.day??'')||new Date(`${x.day}T00:00:00Z`).toISOString().slice(0,10)!==x.day)throw Error('Usage: --mode=preview|commit|audit --day=YYYY-MM-DD');
 if(x.mode==='commit'&&(!x.approved||x.confirm!=='APPROVE_B33_7_MARKETS'))throw Error('Commit requires --approved=reviewed.json and explicit confirmation');
 if(x.mode!=='commit'&&(x.approved||x.confirm))throw Error('Unexpected write authorization');return x;
}
async function originals(folder){
 const dirs=[];
 if(folder){if(!existsSync(folder))throw Error('Original B11 folder not found');dirs.push(resolve(folder));}
 else{for(const e of await readdir(tmpdir(),{withFileTypes:true}))if(e.isDirectory()&&/^b11-energy-/i.test(e.name))dirs.push(join(tmpdir(),e.name,'snapshots'));}
 if(dirs.length>200)throw Error('Unexpectedly many B11 source folders');
 const byHour=new Map();
 for(const dir of dirs){if(!existsSync(dir))continue;
  const list=await readdir(dir,{withFileTypes:true});if(list.length>1000)throw Error('Too many original B11 files');
  for(const ent of list){if(!ent.isFile()||!/^energy_snapshot.*\.json$/i.test(ent.name))continue;
   const file=join(dir,ent.name);if((await stat(file)).size>MAX_SIZE)throw Error('Oversized original B11 source');
   let raw,src;try{raw=await readFile(file);src=JSON.parse(raw.toString('utf8'));}catch{continue;}
   if(!Array.isArray(src.users)||src.users.length!==12||!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(src.timeSlot??''))continue;
   const entry={file,source:src,sha256:createHash('sha256').update(raw).digest('hex'),digest:importedSnapshotDigest(src)};
   const arr=byHour.get(src.timeSlot)??[];arr.push(entry);byHour.set(src.timeSlot,arr);
  }
 }
 return byHour;
}
function trustedCopy(sources,importId,digest){
 const candidates=sources.filter(x=>x.source.snapshotId===importId&&x.digest===digest);
 if(!candidates.length)throw Error('Original B11 source missing or does not match persisted PostgreSQL fingerprint');
 if(new Set(candidates.map(x=>x.sha256)).size!==1)throw Error('Multiple different B11 source files share imported fingerprint: manual review mandatory');
 return [...candidates].sort((a,b)=>a.file.localeCompare(b.file))[0];
}
function safelyRun(script,opts,{env=process.env,timeout=90000}={}){
 const p=spawnSync(process.execPath,['--env-file=.env','--env-file=apps/backend/.env',script,...opts],{cwd:process.cwd(),env,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
 if(p.status!==0||p.error){console.error('Subprocess stopped. Verify the source and database separately; no automatic retry.');throw Error(`B33 ${script} failed with exit ${p.status}`);}return p.stdout;
}
function parseJsonReport(output){const start=output.indexOf('=== B32 FULL-DAY');if(start<0)throw Error('B32 audit did not run');}
async function makeReview(config){
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL missing');
 const u=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/energy_trading'||decodeURIComponent(u.username)!=='energy_admin')throw Error('Only local energy_trading/energy_admin is accepted');
 const b32argv=[`--day=${config.day}`];if(config.snapshots)b32argv.push(`--snapshots=${config.snapshots}`);if(config.python)b32argv.push(`--python=${config.python}`);
 safelyRun('apps/backend/scripts/b32-day-readiness.mjs',b32argv,{timeout:600000});
 const b32file=join(tmpdir(),`MGL850_B32_${config.day}_READ_ONLY_REPORT.json`);
 const report=JSON.parse(await readFile(b32file,'utf8'));
 if(report.hours?.length!==24||report.blockedHours!==0||report.importedHours!==24||report.historicalMatches!==17)throw Error('B32 day data changed; do not approve');
 const bySlot=new Map(report.hours.map(x=>[x.slot,x]));
 const sourceMap=await originals(config.snapshots);
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:20000,statement_timeout:18000,application_name:'mgl850-b33-review-read-only'});
 const configFixture=JSON.parse(await readFile('packages/shared/fixtures/matching-config.sample.json','utf8'));
 const configHash='0x'+hashValue(configFixture);if(!/^0x[0-9a-f]{64}$/.test(configHash))throw Error('Unexpected matching configuration hash');
 const hours=[],rawPlans=new Map();let begun=false;
 try{
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  for(const hour of OTHER_HOURS){
   const slot=`${config.day}T${hour}:00:00Z`;
   const r=bySlot.get(slot);
   if(!r||r.errors?.length||r.legacyMatches<1||!['ORIGINAL_B11_REPLAY_REQUIRED','EXISTING_V2_RECONCILE_ONLY'].includes(r.state))throw Error(`B32 blocked or changed hour ${slot}`);
   const imports=(await db.query('SELECT id,payload_sha256 FROM energy_snapshot_imports WHERE time_slot=$1',[slot])).rows;
   if(imports.length!==1)throw Error(`Missing unique original import for ${slot}`);
   const orig=trustedCopy(sourceMap.get(slot)??[],imports[0].id,imports[0].payload_sha256);
   const pre=await sourcePreflight(db,orig.source);
   const legacy=await runHourlyDryRun(orig.source,pre.registry,configFixture,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:12,python:config.python??(process.platform==='win32'?resolve('.venv/Scripts/python.exe'):resolve('.venv/bin/python')),timeoutMs:40000});
   const plan=makeB28Proposal({source:pre,legacy,sourceId:orig.source.snapshotId});
   const proposalDigest=b28ProposalDigest(plan);
   const enriched={...plan,proposalDigest};
   const view=approvedMarketView(enriched,orig.sha256,slot);
   // Match replay must preserve B12 buyer/seller/energy terms, not only totals.
   const b12=(r.matchesForReview??[]).map(x=>`${x.buyerId}|${x.sellerId}|${x.quantityWh}|${x.priceMicrousdPerKwh}`).sort();
   const v2=plan.allocations.map(x=>`${x.buyerId}|${x.sellerId}|${x.quantityWh}|${x.unitPriceMicrousdPerKwh}`).sort();
   if(JSON.stringify(b12)!==JSON.stringify(v2))throw Error(`B12/V2 economic party or energy mismatch at ${slot}. Manual adjudication required.`);
   if(pre.existing.length){validateCommittedRows(plan,await getReadback(db,plan));}
   hours.push(view);rawPlans.set(slot,{plan,orig});
  }
  await db.query('ROLLBACK');begun=false;
 }finally{if(begun)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});}
 return {review:buildReview(config.day,hours),rawPlans};
}
async function main(){const x=args(process.argv.slice(2));const {review,rawPlans}=await makeReview(x);
 console.log('=== B33 SEVEN-MARKET VERIFIED HALF-EVEN PROPOSALS ===');
 for(const h of review.hours){console.log(`Hour ${h.slot} | ${h.allocationCount} allocations | ${h.amountBaseUnits} TEUSD base units | Market ${h.marketId} | Digest ${h.proposalDigest}`);console.table(h.allocations.map(a=>({buyer:a.buyerId,seller:a.sellerId,Wh:a.quantityWh,price:a.price,baseUnits:a.amountBaseUnits,allocationId:a.id})));}
 console.log('REVIEW DIGEST:',review.reviewDigest);
 if(x.mode==='audit'){console.log('AUDIT PASS: 7 deterministic B28 V2 proposals, zero transactions.');return;}
 if(x.mode==='preview'){
  const file=join(tmpdir(),`MGL850_B33_${x.day}_REVIEW.json`);
  await writeFile(file,JSON.stringify(review,null,2),'utf8');
  console.log('REVIEW FILE:',file);
  console.log('READ ONLY. Review ALL buyer/seller pairs and amounts. Copy the file to a separate APPROVED file only if you approve exactly those financial terms.');return;
 }
 const approved=JSON.parse(await readFile(resolve(x.approved),'utf8'));
 assertApprovedFile(approved,review);
 if(process.env.B28_PERSIST_APPROVAL!=='I_APPROVE_SIMULATED_V2_MARKET')throw Error('Explicit B28_PERSIST_APPROVAL required to commit new V2 markets');
 // The existing B28 market writer is deliberately NOLOGIN. Connect as the
 // approved local energy_admin session, then use SET LOCAL ROLE *inside* a
 // serializable transaction. B28's older unused direct-writer URL is NOT valid.
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 for(const h of review.hours){
  const {orig,plan}=rawPlans.get(h.slot);
  const operate=async trial=>{
   const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:18000,query_timeout:20000,application_name:'mgl850-b33-restricted-market-commit'});
   let inTx=false;
   try{
    await db.connect();await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');inTx=true;
    await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='18s'");
    const {rows:[lock]}=await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',['B33_REVIEWED_MARKET',h.marketId]);
    if(lock.locked!==true)throw Error('Concurrent B33 market writer lock');
    const {rows:roles}=await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='b28_market_writer'");
    if(roles.length!==1)throw Error('The B28 NOLOGIN writer role has not been set up');
    assertSafeRole(roles[0]);
    const {rows:[constraint]}=await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=$1 AND conrelid='\"V2Allocation\"'::regclass",['V2Allocation_terms_check']);
    if(!migrationMatches(constraint?.definition))throw Error('B28 half-even constraint migration is not installed');
    await db.query('SET LOCAL ROLE b28_market_writer');
    const {rows:[identity]}=await db.query('SELECT current_database() AS db,current_user AS actor,session_user AS session_actor');
    assertWriterIdentity(identity);
    const fresh=await sourcePreflight(db,orig.source);
    if(fresh.marketId!==h.marketId||fresh.snapshotHash!==h.snapshotHash||fresh.digest!==importedSnapshotDigest(orig.source)||fresh.importRow.id!==h.snapshotId)throw Error('Original B11 import changed since review');
    if(fresh.existing.length){validateCommittedRows(plan,await getReadback(db,plan));}
    else{
     const stmts=buildB28Statements(plan,{slot:h.slot,configHash:'0x'+hashValue(JSON.parse(await readFile('packages/shared/fixtures/matching-config.sample.json','utf8'))),b11Import:fresh.importRow,b11Digest:fresh.digest});
     for(const st of stmts){const r=await db.query(st.sql,st.values);if(r.rowCount!==1)throw Error('V2 market write did not change exactly one row');}
     validateCommittedRows(plan,await getReadback(db,plan));
    }
    const {rows:measures}=await db.query('SELECT "userId","productionWh","consumptionWh" FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1',[h.snapshotId]);
    const byUser=new Map(measures.map(x=>[x.userId,x]));
    if(measures.length!==12||byUser.size!==12)throw Error('Missing authoritative imported measurements');
    for(const p of plan.positions){const x=byUser.get(p.userId);if(!x||String(x.productionWh)!==p.productionWh||String(x.consumptionWh)!==p.consumptionWh)throw Error('Measurement changed from reviewed B11 source');}
    if(trial){await db.query('ROLLBACK');inTx=false;console.log('PASS: Rollback-only real PostgreSQL trial',h.slot);}
    else {await db.query('COMMIT');inTx=false;console.log('PASS: Reviewed V2 market committed or independently verified',h.slot);}
   }catch(e){if(inTx)await db.query('ROLLBACK').catch(()=>{});throw e;}
   finally{await db.end().catch(()=>{});}
  };
  console.log('B33 market:',h.slot,h.marketId,h.planId);
  await operate(true);
  await operate(false);
 }
 console.log('PASS: 7 independently committed/reverified markets, under B28 restricted writer. Zero Hedera payments sent.');
}
main().catch(e=>{console.error('B33 MARKET STOP:',String(e?.message??e).replace(/postgres(?:ql)?:\/\/[^\s]+/ig,'[DATABASE URL REDACTED]'));process.exitCode=1;});
