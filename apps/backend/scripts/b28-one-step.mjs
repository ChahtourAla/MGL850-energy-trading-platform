/**
 * B28.1 single-command completion for the previously reviewed, fixed simulated
 * 2026-11-10T14:00Z market. No Hedera, wallet signing, token approvals, or transfers.
 * Application source contracts and the B22/B26 local restrictions are untouched.
 *
 * This tool is deliberately NOT reusable for arbitrary markets. New markets
 * require explicit review and a separate approved workflow.
 */
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hashValue} from './b12-matching-core.mjs';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
import {makeB28Proposal,buildB28Statements,validateCommittedRows} from './b28-v2-core.mjs';
import {b28ProposalDigest,validateB28Approval} from './b28-commit-approval.mjs';
import {connection,dbIdentity,sourcePreflight,getReadback} from './b28-v2-market.mjs';
import {MIGRATION_NAME,TARGET,assertTarget,assertAdminIdentity,assertWriterIdentity,assertSafeRole,pendingMigrations,migrationMatches,sha256,ROLE_SETUP_SQL} from './b28-one-step-core.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const MIG_DIR=resolve(ROOT,'database/migrations');
const CONFIG=resolve(ROOT,'packages/shared/fixtures/matching-config.sample.json');
const MIG_FILE=resolve(MIG_DIR,MIGRATION_NAME,'migration.sql');
const POSTGRES_TIMEOUT=20000;
const EXPECTED_APP_USER='energy_admin';
const SHA_RE=/^[0-9a-f]{64}$/;
function parse(args){
 const options={apply:false,snapshot:null};
 for(const arg of args){
  if(arg==='--apply'&&!options.apply){options.apply=true;continue;}
  if(arg.startsWith('--snapshot=')&&!options.snapshot){options.snapshot=resolve(arg.slice('--snapshot='.length));continue;}
  throw Error('Only --apply and --snapshot=<original-B11-JSON> options are permitted');
 }
 if(!options.apply||!options.snapshot)throw Error('Explicit --apply and --snapshot are both required');
 return options;
}
function maskedError(e){
 const s=String(e?.message||e);
 // Avoid ever printing connection credentials on unexpected pg errors.
 if(/postgres(?:ql)?:\/\//i.test(s))return 'Database error includes a connection string; details suppressed';
 return s.replace(/password[^\n]*/gi,'password [REDACTED]');
}
async function connectAdmin(label){
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const c=new pg.Client({connectionString:connection('admin',process.env.DATABASE_URL),connectionTimeoutMillis:5000,query_timeout:POSTGRES_TIMEOUT,statement_timeout:18000,application_name:'mgl850-b28-'+label});
 await c.connect();
 return c;
}
async function identity(c){
 const {rows:[r]}=await c.query('SELECT current_database() AS db, current_user AS actor, session_user AS session_actor');
 return r;
}
async function readConstraint(c){
 const {rows}=await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='V2Allocation_terms_check' AND conrelid='\"V2Allocation\"'::regclass");
 if(rows.length!==1)throw Error('Missing or conflicting V2Allocation terms constraint');
 return rows[0].definition;
}
async function readPrismaMigrationState(){
 const client=await connectAdmin('migrations-read');let active=false;
 try{
  await client.query('BEGIN READ ONLY');active=true;
  assertAdminIdentity(await identity(client));
  const {rows}=await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations');
  const files=(await readdir(MIG_DIR,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  const applyNeeded=pendingMigrations(files,rows);
  const sql=await readFile(MIG_FILE,'utf8');
  const previous=rows.find(r=>r.migration_name===MIGRATION_NAME && r.finished_at && !r.rolled_back_at);
  if(previous && (!SHA_RE.test(previous.checksum)||previous.checksum!==sha256(sql)))throw Error('B28 recorded Prisma migration checksum mismatch');
  const constraint=await readConstraint(client);
  if(!applyNeeded&&!migrationMatches(constraint))throw Error('Prisma says B28 applied, but live constraint disagrees');
  if(applyNeeded&&migrationMatches(constraint))throw Error('B28 constraint present but Prisma migration is not recorded; DBA reconciliation needed');
  return {applyNeeded,sql,alreadyActive:!applyNeeded};
 }finally{
  if(active)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
 }
}
async function prepareProposal(snapshot){
 const config=JSON.parse(await readFile(CONFIG,'utf8'));
 const configHash='0x'+hashValue(config);
 const c=await connectAdmin('source-check');let active=false;let source;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');active=true;
  assertAdminIdentity(await identity(c));
  source=await sourcePreflight(c,snapshot);
 }finally{
  if(active)await c.query('ROLLBACK').catch(()=>{});
  await c.end().catch(()=>{});
 }
 const python=process.platform==='win32'?resolve(ROOT,'.venv/Scripts/python.exe'):resolve(ROOT,'.venv/bin/python');
 const legacy=await runHourlyDryRun(snapshot,source.registry,config,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:12,python,timeoutMs:30000});
 const plan=makeB28Proposal({source,legacy,sourceId:snapshot.snapshotId});
 const pinned=assertTarget(plan,source.slot);
 const proposalDigest=b28ProposalDigest(plan);
 validateB28Approval({confirmation:TARGET.marketId,planConfirmation:TARGET.planId,proposalConfirmation:proposalDigest},plan,'I_APPROVE_SIMULATED_V2_MARKET');
 return {plan,source,configHash,proposalDigest,pinned};
}
async function setupRole(c){
 const {rows}=await c.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='b28_market_writer'");
 assertSafeRole(rows[0]??null);
 await c.query(ROLE_SETUP_SQL);
 const {rows:verified}=await c.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='b28_market_writer'");
 if(verified.length!==1)throw Error('B28 non-login writer was not created');
 assertSafeRole(verified[0]);
}
async function operation({proposal,snapshot,schemaSql,trial}){
 const {plan,source,configHash}=proposal;
 const c=await connectAdmin(trial?'rollback-trial':'authoritative-commit');let active=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');active=true;
  await c.query("SET LOCAL lock_timeout = '5s'");
  await c.query("SET LOCAL statement_timeout = '18s'");
  assertAdminIdentity(await identity(c));
  const {rows:[lock]}=await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',['B28_FIXED_MARKET',plan.marketId]);
  if(lock.locked!==true)throw Error('Another B28 market operation holds the transaction lock');
  if(schemaSql){
   if(migrationMatches(await readConstraint(c)))throw Error('B28 migration already present unexpectedly');
   await c.query(schemaSql);
  }
  if(!migrationMatches(await readConstraint(c)))throw Error('Versioned half-even SQL constraint is absent');
  await setupRole(c);
  await c.query('SET LOCAL ROLE b28_market_writer');
  assertWriterIdentity(await identity(c));
  const fresh=await sourcePreflight(c,snapshot);
  if(fresh.marketId!==plan.marketId||fresh.snapshotHash!==plan.snapshotHash||fresh.importRow.id!==plan.snapshotId||fresh.digest!==source.digest)throw Error('Historical import changed between preview and commit');
  let state;
  if(fresh.existing.length){
   validateCommittedRows(plan,await getReadback(c,plan));
   state='REUSED_VERIFIED';
  }else{
   const statements=buildB28Statements(plan,{slot:fresh.slot,configHash,b11Import:fresh.importRow,b11Digest:fresh.digest});
   for(const s of statements){
    const r=await c.query(s.sql,s.values);
    if(s.sql.startsWith('UPDATE ')&&r.rowCount!==1)throw Error('A B28 state transition did not affect exactly one row');
    if(s.sql.startsWith('INSERT ')&&r.rowCount!==1)throw Error('A B28 fact insert did not affect exactly one row');
   }
   validateCommittedRows(plan,await getReadback(c,plan));
   // The core readback does not cover measurements, so validate them separately.
   const {rows:measures}=await c.query('SELECT "userId","productionWh","consumptionWh" FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1',[plan.snapshotId]);
   if(measures.length!==plan.positions.length)throw Error('V2 measurements missing after insert');
   const byId=new Map(measures.map(r=>[r.userId,r]));
   for(const p of plan.positions){const m=byId.get(p.userId);if(!m||String(m.productionWh)!==p.productionWh||String(m.consumptionWh)!==p.consumptionWh)throw Error('V2 measurement/source mismatch');}
   state='AUTHORITATIVE_V2_COMMITTED';
  }
  if(trial){
   await c.query('ROLLBACK');active=false;
   console.log('PASS: FULL PostgreSQL integration trial rolled back (schema, role, and V2 rows not persisted).');
   return {state:'ROLLBACK_TRIAL_VERIFIED',allocations:plan.allocations.length};
  }
  await c.query('COMMIT');active=false;
  return {state,marketId:plan.marketId,planId:plan.planId,allocations:plan.allocations.length,positions:plan.positions.length};
 }catch(e){if(active)await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{await c.end().catch(()=>{});}
}
function runPrismaMigration(){
 console.log('=== Applying only the reviewed B28 migration through Prisma ===');
 const win=process.platform==='win32';
 const executable=win?'cmd.exe':'corepack';
 const config=existsSync(resolve(ROOT,'prisma7.config.ts'))?'prisma7.config.ts':existsSync(resolve(ROOT,'prisma.config.ts'))?'prisma.config.ts':null;
 const parts=['pnpm','exec','prisma','migrate','deploy','--schema','database/schema.prisma'];
 if(config)parts.push('--config',config);
 const args=win?['/d','/s','/c','corepack '+parts.join(' ')]:parts;
 const r=spawnSync(executable,args,{cwd:ROOT,env:process.env,encoding:'utf8',maxBuffer:1024*1024*2,timeout:120000,windowsHide:true});
 if(r.error||r.status!==0)throw Error('Prisma migrate deploy failed. Inspect the Prisma CLI locally; no allocation commit attempted.');
 console.log('PASS: Prisma migration deploy exited successfully.');
}
async function verifyAfterCommit(plan){
 const c=await connectAdmin('independent-final-readback');let active=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');active=true;
  assertAdminIdentity(await identity(c));
  const {rows:[migration]}=await c.query('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1 ORDER BY started_at DESC LIMIT 1',[MIGRATION_NAME]);
  const content=await readFile(MIG_FILE,'utf8');
  if(!migration?.finished_at||migration.rolled_back_at||migration.checksum!==sha256(content))throw Error('Prisma migration history is not consistent');
  if(!migrationMatches(await readConstraint(c)))throw Error('B28 constraint missing after commit');
  validateCommittedRows(plan,await getReadback(c,plan));
  const counts={};
  for(const [label,sql,args] of [
   ['markets','SELECT count(*)::int AS n FROM "V2Market" WHERE id=$1',[plan.marketId]],
   ['snapshots','SELECT count(*)::int AS n FROM "V2Snapshot" WHERE "marketId"=$1',[plan.marketId]],
   ['plans','SELECT count(*)::int AS n FROM "V2AllocationPlan" WHERE "marketId"=$1',[plan.marketId]],
   ['allocations','SELECT count(*)::int AS n FROM "V2Allocation" WHERE "marketId"=$1',[plan.marketId]],
   ['positions','SELECT count(*)::int AS n FROM "V2Position" WHERE "marketId"=$1',[plan.marketId]],
   ['measurements','SELECT count(*)::int AS n FROM "V2SnapshotMeasurement" WHERE "marketId"=$1',[plan.marketId]],
   ['settlementIntents','SELECT count(*)::int AS n FROM "V2SettlementIntent" WHERE "marketId"=$1',[plan.marketId]],
  ])counts[label]=(await c.query(sql,args)).rows[0].n;
  if(counts.markets!==1||counts.snapshots!==1||counts.plans!==1||counts.allocations!==3||counts.positions!==12||counts.measurements!==12||counts.settlementIntents!==0)throw Error('Post-commit V2 counts do not match expected isolated first market');
  const {rows:amounts}=await c.query('SELECT "buyerId","sellerId","quantityWh","amountBaseUnits",remainder FROM "V2Allocation" WHERE "marketId"=$1',[plan.marketId]);
  const total=amounts.reduce((n,r)=>n+BigInt(r.amountBaseUnits),0n);
  if(total!==TARGET.totalBaseUnits)throw Error('Persisted financial sum mismatch');
  const {rows:[role]}=await c.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='b28_market_writer'");
  if(!role||role.rolcanlogin||role.rolsuper||role.rolbypassrls)throw Error('Writer role has unexpected login or superuser capability');
  console.log(JSON.stringify({state:'B28_1_COMPLETED_AND_INDEPENDENTLY_VERIFIED',simulationOnly:true,marketId:plan.marketId,planId:plan.planId,policy:plan.policy,counts,totalTeusdBaseUnits:total.toString(),totalTeusd:'0.458177',writerRole:'b28_market_writer (NOLOGIN)',hederaTransactions:0},null,2));
 }finally{
  if(active)await c.query('ROLLBACK').catch(()=>{});
  await c.end().catch(()=>{});
 }
}
async function main(){
 const opts=parse(process.argv.slice(2));
 console.log('=== B28.1 ONE-STEP AUTHORITATIVE V2 INTEGRATION (SIMULATED) ===');
 const snapshot=JSON.parse(await readFile(opts.snapshot,'utf8'));
 const proposal=await prepareProposal(snapshot);
 console.log(JSON.stringify({stage:'APPROVED_FIXED_MARKET_PREVIEW',marketId:proposal.plan.marketId,planId:proposal.plan.planId,snapshotId:proposal.plan.snapshotId,allocationCount:3,totalBaseUnits:proposal.pinned.totalBaseUnits,proposalDigest:proposal.proposalDigest},null,2));
 const migration=await readPrismaMigrationState();
 console.log('Migration state:',migration.applyNeeded?'PENDING (only reviewed B28 migration)':'ALREADY_APPLIED');
 console.log('=== Rollback-only real PostgreSQL trial ===');
 await operation({proposal,snapshot,schemaSql:migration.applyNeeded?migration.sql:null,trial:true});
 if(migration.applyNeeded)runPrismaMigration();
 const finalMigration=await readPrismaMigrationState();
 if(finalMigration.applyNeeded)throw Error('Prisma failed to mark the B28 migration applied');
 console.log('=== Authoritative restricted-role transaction ===');
 const outcome=await operation({proposal,snapshot,schemaSql:null,trial:false});
 console.log('PostgreSQL transaction outcome:',outcome.state);
 await verifyAfterCommit(proposal.plan);
 console.log('PASS: B28.1 finished; no token approval, signing or Hedera transaction occurred.');
}
main().catch(e=>{console.error('B28.1 STOP:',maskedError(e));console.error('No automatic retry. Review database state; all failed market transactions are rolled back.');process.exitCode=1;});
