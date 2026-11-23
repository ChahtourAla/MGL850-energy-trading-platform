/**
 * B28.1 persistent V2 market preparation (simulation only).
 * DEFAULT IS READ ONLY. Database commit requires a distinct, least-privilege
 * role, an exact plan confirmation, explicit environment opt-in, and a
 * reviewed version-aware SQL migration. No Hedera/wallet-signing operations.
 *
 * Usage (repository root):
 * node --env-file=apps/backend/.env apps/backend/scripts/b28-v2-market.mjs --snapshot=<ORIGINAL_B11_JSON>
 * ... --snapshot=<ORIGINAL_B11_JSON> --commit --confirm-market=<marketId> --confirm-plan=<planId> --confirm-proposal=<proposalDigest>
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {marketId,snapshotHash} from '../../../packages/shared/v2-identity.mjs';
import {hashValue,importedSnapshotDigest} from './b12-matching-core.mjs';
import {verifyImportedSource} from './b22-registry-verification.mjs';
import {runHourlyDryRun} from './b22-hourly-core.mjs';
import {makeB28Proposal,buildB28Statements,validateCommittedRows} from './b28-v2-core.mjs';
import {b28ProposalDigest,parseB28Args,validateB28Approval} from './b28-commit-approval.mjs';

const HEX=/^0x[0-9a-f]{64}$/;
const POLICY='b28-teusd-half-even-1';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
function connection(label,raw,role){
 if(!raw)throw Error(`B28 ${label} database connection missing`);
 let u;try{u=new URL(raw);}catch{throw Error('Invalid B28 database URL');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/energy_trading'||(u.searchParams.size>0&&(u.searchParams.size!==1||u.searchParams.get('schema')!=='public'))||u.hash)throw Error('B28 accepts only local energy_trading PostgreSQL database');
 if(role&&decodeURIComponent(u.username)!==role)throw Error(`B28 requires dedicated ${role} writer role`);
 return raw;
}
async function dbIdentity(client,role){
 const {rows:[r]}=await client.query('SELECT current_database() AS db,current_user AS actor,current_setting(\'transaction_read_only\') AS readonly');
 if(r.db!=='energy_trading'||(role&&r.actor!==role))throw Error('Unexpected B28 database principal or name');
 return r;
}
async function sourcePreflight(client,snapshot){
 if(snapshot?.schemaVersion!=='1.0.0'||snapshot?.generatorVersion!=='1.0.0'||!Array.isArray(snapshot.users)||snapshot.users.length!==12)throw Error('B28 expected original B11 V1 12-household snapshot');
 const slot=snapshot.timeSlot;
 if(typeof slot!=='string'||!/\d{4}-\d{2}-\d{2}T\d{2}:00:00Z/.test(slot)||!Number.isFinite(Date.parse(slot))||new Date(slot).toISOString()!==slot.replace('Z','.000Z')||Date.parse(slot)+3600000>Date.now())throw Error('B28 source hour not closed and canonical');
 const ids=snapshot.users.map(u=>u.userId);
 if(new Set(ids).size!==ids.length)throw Error('Duplicate B11 household IDs');
 const checked=await verifyImportedSource(client,snapshot,ids);
 if(!checked.sourceConsistencyVerified)throw Error('B11 fingerprint or identity verification failed');
 const {rows}=await client.query('SELECT id,time_slot,schema_version,generator_version,payload_sha256,record_count,imported_at FROM energy_snapshot_imports WHERE id=$1',[snapshot.snapshotId]);
 if(rows.length!==1||rows[0].payload_sha256!==importedSnapshotDigest(snapshot)||Number(rows[0].record_count)!==12)throw Error('B11 stored import fingerprint missing or invalid');
 const start=new Date(slot),end=new Date(start.getTime()+3600000);
 const id=marketId('hourly','HOURLY',start.toISOString(),end.toISOString());
 const readings=snapshot.users.map(u=>({userId:u.userId,productionWh:String(u.productionWh),consumptionWh:String(u.consumptionWh)}));
 const hash=snapshotHash(id,readings);
 const v2=await client.query('SELECT id,status FROM "V2Market" WHERE id=$1',[id]);
 return {marketId:id,snapshotHash:hash,slot,registry:checked.registry,existing:v2.rows,importRow:{id:rows[0].id,schemaVersion:rows[0].schema_version,generatorVersion:rows[0].generator_version,importedAt:rows[0].imported_at},digest:rows[0].payload_sha256};
}
async function getReadback(client,plan){
 const [market,snapshot,dbPlan,allocations,positions]=[
  await client.query('SELECT id,status FROM "V2Market" WHERE id=$1',[plan.marketId]),
  await client.query('SELECT id,status,"payloadHash" FROM "V2Snapshot" WHERE id=$1',[plan.snapshotId]),
  await client.query('SELECT id,status,"manifestHash","planVersion" FROM "V2AllocationPlan" WHERE id=$1',[plan.planId]),
  await client.query('SELECT * FROM "V2Allocation" WHERE "marketId"=$1',[plan.marketId]),
  await client.query('SELECT * FROM "V2Position" WHERE "marketId"=$1',[plan.marketId]),
 ];
 return {market:market.rows[0],snapshot:snapshot.rows[0],dbPlan:dbPlan.rows[0],allocations:allocations.rows,positions:positions.rows};
}
async function commitMarket({options,snapshot,plan,configHash}){
 validateB28Approval(options,plan,process.env.B28_PERSIST_APPROVAL);
 const conn=connection('writer',process.env.B28_WRITER_DATABASE_URL,'b28_market_writer');
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const client=new pg.Client({connectionString:conn,connectionTimeoutMillis:5000,query_timeout:12000,statement_timeout:10000,application_name:'mgl850-b28-v2-simulated-commit'});
 let started=false;
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');started=true;
  const identity=await dbIdentity(client,'b28_market_writer');
  if(identity.readonly!=='off')throw Error('B28 writer is read-only');
  // Fail before writes if migration is absent; never weaken B22 or B24.
  const {rows:[migration]}=await client.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='V2Allocation_terms_check' AND pg_get_constraintdef(oid) LIKE '%b28-teusd-half-even-1%'");
  if(migration.n!==1)throw Error('B28 pricing-aware V2Allocation constraint migration not installed');
  // Recheck original B11 fingerprint, original identities and current trusted profiles
  // within the exact committing transaction; no external source accepted by default.
  const checked=await sourcePreflight(client,snapshot);
  if(checked.marketId!==plan.marketId||checked.snapshotHash!==plan.snapshotHash||checked.importRow.id!==plan.snapshotId)throw Error('B11 data changed before B28 commit');
  if(checked.existing.length>0){
   const reused=validateCommittedRows(plan,await getReadback(client,plan));
   await client.query('COMMIT');started=false;
   return {state:'REUSED_VERIFIED',...reused};
  }
  const statements=buildB28Statements(plan,{slot:checked.slot,configHash,b11Import:checked.importRow,b11Digest:checked.digest});
  for(const s of statements){
   const result=await client.query(s.sql,s.values);
   if(s.sql.startsWith('UPDATE ')&&result.rowCount!==1)throw Error('B28 status transition did not change exactly one record');
  }
  const verified=validateCommittedRows(plan,await getReadback(client,plan));
  await client.query('COMMIT');started=false;
  return {state:'AUTHORITATIVE_V2_COMMITTED',...verified};
 }catch(error){if(started)await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{await client.end().catch(()=>{});}
}

export async function main(argv=process.argv.slice(2)){
 const options=parseB28Args(argv);
 if(options.commit&&(!options.confirmation||!options.planConfirmation||!options.proposalConfirmation||!process.env.B28_WRITER_DATABASE_URL))throw Error('B28 commit requires all three confirmations and a separate writer database URL');
 const snapshot=JSON.parse(await readFile(options.snapshot,'utf8'));
 const config=JSON.parse(await readFile(resolve(ROOT,'packages/shared/fixtures/matching-config.sample.json'),'utf8'));
 const configHash='0x'+hashValue(config);
 const conn=connection('source',process.env.DATABASE_URL);
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const client=new pg.Client({connectionString:conn,connectionTimeoutMillis:5000,query_timeout:12000,statement_timeout:10000,application_name:'mgl850-b28-v2-simulated-preview'});
 let begun=false;let source;
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  await dbIdentity(client);
  source=await sourcePreflight(client,snapshot);
 }finally{
  if(begun)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
 }
 const legacy=await runHourlyDryRun(snapshot,source.registry,config,{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:12,python:options.python,timeoutMs:30000});
 const plan=makeB28Proposal({source,legacy,sourceId:snapshot.snapshotId});
 console.log('=== B28.1 VERIFIED SIMULATED V2 MARKET PROPOSAL ===');
 console.log(JSON.stringify({simulationOnly:true,source:'B11_PERSISTED_FINGERPRINT',interval:source.slot,marketId:plan.marketId,snapshotId:plan.snapshotId,snapshotHash:plan.snapshotHash,planId:plan.planId,manifestHash:plan.manifestHash,pricingPolicyVersion:POLICY,allocationCount:plan.allocations.length,proposalDigest:b28ProposalDigest(plan),existingV2Market:source.existing.length>0,readOnlyPreview:!options.commit},null,2));
 console.table(plan.allocations.map(a=>({buyer:a.buyerId.slice(0,8),seller:a.sellerId.slice(0,8),quantityWh:a.quantityWh,amountBaseUnits:a.amountBaseUnits,remainder:a.remainder,roundingDeltaNumerator:a.roundingDeltaNumerator})));
 if(!options.commit){console.log('PREVIEW PASS: No V2 rows written; no Hedera operation. To commit, first review migration and writer-role setup; explicit approval required.');return;}
 const outcome=await commitMarket({options,snapshot,plan,configHash});
 console.log(JSON.stringify({...outcome,simulationOnly:true,onChainTransactions:0},null,2));
}
export {connection,dbIdentity,sourcePreflight,getReadback};
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await main();}
 catch(e){console.error(`B28 STOP: ${e?.message??String(e)}. No automatic retry. Inspect V2 state before resubmitting.`);process.exitCode=1;}
}
