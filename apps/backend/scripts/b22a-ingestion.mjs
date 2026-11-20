/** Controlled B22-A local simulator. No caller-provided readings or wallet keys. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {requireHour} from './b11-pipeline-core.mjs';
import {marketId} from '../../../packages/shared/v2-identity.mjs';
import {importedSnapshotDigest} from './b12-matching-core.mjs';
import {prepareHourly} from './b22-hourly-core.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const configPath=join(root,'services/data-generator/config/energy-generation-config.json');
const matchPath=join(root,'packages/shared/fixtures/matching-config.sample.json');
const pythonPath=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const digest=value=>'0x'+createHash('sha256').update(value).digest('hex');
async function assertDisposable(client){
 const target=client.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b22_ingest')throw Error('Refusing non-disposable database target');
 const marker=await client.query("SELECT current_database() AS name, EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS ok");
 if(marker.rows[0]?.name!=='b22_disposable_review'||marker.rows[0]?.ok!==true)throw Error('Disposable database marker missing');
}
/** Read-only historical reconciliation: never regenerates or consults mutable profiles. */
export async function inspectHistoricalHour(client,timeSlot){
 requireHour(timeSlot);await assertDisposable(client);
 const start=new Date(timeSlot).toISOString(),end=new Date(Date.parse(timeSlot)+3600000).toISOString(),id=marketId('hourly','HOURLY',start,end);
 const rows=await client.query('SELECT s.id,s.status,s."marketId",s."payloadHash",s."configHash",s."expectedCount",s."actualCount",s."supersedesId",i."registryId",i."marketId" AS "auditMarket",i."sourceIdentity",i."sourceVersion",i.principal,i."payloadHash" AS "auditHash",i."configHash" AS "auditConfig",i."contentDigest",i."executableHash",i.payload,i.result,r."intervalStart" AS "registryStart",r."intervalEnd" AS "registryEnd",jsonb_array_length(r.profiles) AS "registryCount",(SELECT count(*)::int FROM "V2SnapshotMeasurement" x WHERE x."snapshotId"=s.id) AS "measurementCount",(SELECT count(DISTINCT p->>\'userId\')::int FROM jsonb_array_elements(COALESCE(r.profiles,\'[]\'::jsonb)) p JOIN "V2SnapshotMeasurement" x ON x."snapshotId"=s.id AND x."userId"::text=p->>\'userId\') AS "registryMatched",(SELECT count(DISTINCT p->>\'userId\')::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.payload->\'users\')=\'array\' THEN i.payload->\'users\' ELSE \'[]\'::jsonb END) p JOIN "V2SnapshotMeasurement" x ON x."snapshotId"=s.id AND x."userId"::text=p->>\'userId\' AND x."productionWh"::text=p->>\'productionWh\' AND x."consumptionWh"::text=p->>\'consumptionWh\') AS "payloadMatched", "v2_snapshot_measurement_hash"(s.id) AS "actualHash" FROM "V2Snapshot" s LEFT JOIN "B22Ingestion" i ON i."snapshotId"=s.id LEFT JOIN "B22HourlyRegistry" r ON r.id=i."registryId" WHERE s."marketId"=$1 ORDER BY s."collectedAt" DESC,s.id',[id]);
 if(!rows.rows.length){const market=await client.query('SELECT status FROM "V2Market" WHERE id=$1',[id]);return market.rowCount?{marketId:id,state:'QUARANTINED',marketStatus:market.rows[0].status,snapshots:[]}:{marketId:id,state:'ABSENT',snapshots:[]};}
 const snapshots=rows.rows.map(s=>{const trusted=s.status==='FINALIZED'&&s.registryId&&s.auditMarket===id&&s.sourceIdentity==='BACKEND_LOCAL_SIMULATOR'&&s.sourceVersion==='1.0.0'&&s.principal==='b22_ingest'&&s.auditHash===s.payloadHash&&s.auditConfig===s.configHash&&s.actualHash===s.payloadHash&&s.measurementCount===s.expectedCount&&s.actualCount===s.expectedCount&&s.registryCount===s.expectedCount&&s.registryMatched===s.expectedCount&&s.payloadMatched===s.expectedCount&&s.payload?.snapshotId===s.id&&s.payload?.timeSlot===timeSlot&&Array.isArray(s.payload?.users)&&s.payload.users.length===s.expectedCount&&'0x'+importedSnapshotDigest(s.payload)===s.contentDigest&&s.registryStart?.toISOString()===start&&s.registryEnd?.toISOString()===end&&s.result==='FINALIZED'&&/^0x[0-9a-f]{64}$/.test(s.executableHash??'');return {snapshotId:s.id,status:s.status,supersedesId:s.supersedesId,measurementCount:s.measurementCount,expectedCount:s.expectedCount,payloadHash:s.payloadHash,provenancePresent:!!s.registryId,verified:!!trusted};});
 if(snapshots.some(s=>!s.verified))return {marketId:id,state:'QUARANTINED',snapshots};
 const referenced=new Set(snapshots.map(s=>s.supersedesId).filter(Boolean));const heads=snapshots.filter(s=>!referenced.has(s.snapshotId));
 if(heads.length!==1||snapshots.some(s=>s.supersedesId&&!snapshots.some(p=>p.snapshotId===s.supersedesId)))return {marketId:id,state:'QUARANTINED',snapshots};
 const visited=new Set();let cursor=heads[0];while(cursor){if(visited.has(cursor.snapshotId))return {marketId:id,state:'QUARANTINED',snapshots};visited.add(cursor.snapshotId);cursor=cursor.supersedesId?snapshots.find(s=>s.snapshotId===cursor.supersedesId):null;}if(visited.size!==snapshots.length)return {marketId:id,state:'QUARANTINED',snapshots};
 return {marketId:id,state:'FINALIZED',snapshots:[heads[0],...snapshots.filter(s=>s!==heads[0])]};
}
function generatorHash(){const h=createHash('sha256');h.update(readFileSync(pythonPath));for(const dir of ['services/data-generator/data_generator','packages/shared/python/p2p_energy_shared']){const folder=join(root,dir);for(const name of readdirSync(folder).filter(x=>x.endsWith('.py')).sort()){h.update(dir+'/'+name+'\0');h.update(readFileSync(join(folder,name)));}}return '0x'+h.digest('hex');}
async function readRegistry(client,timeSlot,lock=false){
 const rows=await client.query('SELECT id,profiles,"approvedBy",revision FROM "B22HourlyRegistry" WHERE "intervalStart"=$1 AND "intervalEnd"=$1::timestamptz+interval \'1 hour\' ORDER BY revision DESC LIMIT 1',[timeSlot]);
 if(rows.rows.length!==1)throw Error('No approved participant registry for interval');
 const registry=rows.rows[0], users=registry.profiles;
 if(!Array.isArray(users)||!users.length||users.length>200||!registry.approvedBy)throw Error('Invalid approved roster');
 const ids=users.map(u=>u.userId),unique=new Set(ids);if(unique.size!==ids.length)throw Error('Duplicate approved participant');
 if(lock)await client.query('SELECT "b22_lock_profiles"($1::uuid[])',[ids]);
 const db=await client.query('SELECT u.id,u.name,u.email,u.physical_address AS "physicalAddress",u.x_km AS "xKm",u.y_km AS "yKm",u.reputation,u.preferred_energy_type AS "preferredEnergyType",w.hedera_account_id AS "hederaAccountId",w.evm_address AS "evmAddress" FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=ANY($1::uuid[])',[ids]);
 if(db.rows.length!==ids.length)throw Error('Approved participant or wallet missing');
 const profiles=new Map(db.rows.map(p=>[p.id,p]));
 for(const u of users){const p=profiles.get(u.userId);if(!p||p.xKm===null||p.yKm===null||['name','email','physicalAddress','reputation','preferredEnergyType','hederaAccountId','evmAddress'].some(k=>u[k]!==p[k])||u.xKm!==Number(p.xKm)||u.yKm!==Number(p.yKm))throw Error('Approved roster no longer matches database registry');}
 return {id:registry.id,users};
}

/** Generates its own input. No snapshot, source policy or participant list is accepted. */
export async function ingestLocalHour(client,timeSlot,{execute=false,correction=false}={}){
 requireHour(timeSlot);const end=new Date(Date.parse(timeSlot)+3600000);if(end.getTime()>Date.now())throw Error('Hour is not complete');
 if(!execute)throw Error('Database ingestion requires explicit execute; use b22-hourly-dry-run for read-only preview');
 await assertDisposable(client);
 const historical=await inspectHistoricalHour(client,timeSlot);if(historical.state==='QUARANTINED')throw Error('Incomplete or inconsistent historical draft; inspect before recovery');if(!correction&&historical.state==='FINALIZED'){const s=historical.snapshots[0];return {marketId:historical.marketId,snapshotId:s.snapshotId,payloadHash:s.payloadHash,reused:true};}
 const roster=await readRegistry(client,timeSlot), temp=await mkdtemp(join(tmpdir(),'mgl850-b22a-'));
 let snapshot;
 const configBytes=readFileSync(configPath),configHash=digest(configBytes);
 const executableHash=generatorHash();
 try {
  const inputFile=join(temp,'registry.json'),localConfig=join(temp,'config.json');await writeFile(inputFile,JSON.stringify({schemaVersion:'1.0.0',users:roster.users}),{flag:'wx'});await writeFile(localConfig,configBytes,{flag:'wx'});
  const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,PYTHONPATH:[join(root,'packages/shared/python'),join(root,'services/data-generator')].join(delimiter)};
  const proc=spawnSync(pythonPath,['-m','data_generator.cli','generate-snapshot','--registry',inputFile,'--config',localConfig,'--time-slot',timeSlot,'--output-dir',temp],{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});
  if(proc.error||proc.status!==0)throw Error(`Local generator failed: ${proc.error?.message??proc.stderr?.slice(0,500)}`);
  if(generatorHash()!==executableHash)throw Error('Generator files changed during execution');
  snapshot=JSON.parse(await readFile(join(temp,`energy_snapshot_${timeSlot.slice(0,13)}.json`),'utf8'));
 } finally {await rm(temp,{recursive:true,force:true});}
 const prepared=prepareHourly(snapshot,{users:roster.users},JSON.parse(readFileSync(matchPath,'utf8')),{sourcePolicy:'LOCAL_SIMULATOR_V1',expectedUsers:roster.users.length});
 const contentDigest='0x'+importedSnapshotDigest(snapshot),market=prepared.manifest.marketId,hash=prepared.snapshotHash;
 await client.query('BEGIN');
 try {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['B22A_MARKET',market]);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['B22A_REGISTRY',timeSlot]);
  const lockedHistory=await inspectHistoricalHour(client,timeSlot);if(lockedHistory.state==='QUARANTINED')throw Error('Incomplete or inconsistent historical draft; inspect before recovery');if(correction&&lockedHistory.snapshots[0]?.snapshotId!==historical.snapshots[0]?.snapshotId)throw Error('Historical snapshot changed during correction');
  const checked=await readRegistry(client,timeSlot,true);if(checked.id!==roster.id||JSON.stringify(checked.users)!==JSON.stringify(roster.users))throw Error('Roster changed during generator execution');
  await client.query('INSERT INTO "V2Market"(id,namespace,mode,"intervalStart","intervalEnd",status,"schemaVersion","configVersion","updatedAt") VALUES($1,\'hourly\',\'HOURLY\',$2,$3,\'DISCOVERED\',\'2.0.0\',\'B22A_LOCAL_V1\',now()) ON CONFLICT (id) DO NOTHING',[market,timeSlot,end]);
  const m=await client.query('SELECT * FROM "V2Market" WHERE id=$1 FOR UPDATE',[market]);if(m.rows.length!==1||m.rows[0].namespace!=='hourly'||m.rows[0].configVersion!=='B22A_LOCAL_V1')throw Error('Conflicting existing market');
  const existing=await client.query('SELECT s.*,i."contentDigest",i."registryId",i."executableHash" FROM "V2Snapshot" s LEFT JOIN "B22Ingestion" i ON i."snapshotId"=s.id WHERE s."marketId"=$1 ORDER BY s."collectedAt" DESC,s.id',[market]);
  const same=existing.rows.find(e=>e.id===snapshot.snapshotId);
  if(same){const e=same;if(e.status!=='FINALIZED'||e.payloadHash!==hash||e.contentDigest!==contentDigest||e.registryId!==roster.id||e.executableHash!==executableHash||e.configHash!==configHash)throw Error('Conflicting or incomplete market; inspect before recovery');const check=await client.query('SELECT "v2_snapshot_measurement_hash"($1) AS hash',[e.id]);if(check.rows[0].hash!==hash)throw Error('Persisted measurement hash mismatch');await client.query('COMMIT');return {marketId:market,snapshotId:e.id,payloadHash:hash,reused:true};}
  let supersedesId=null;
  if(existing.rows.length){
   if(!correction||existing.rows.some(e=>e.status!=='FINALIZED'||!e.registryId))throw Error('Conflicting or incomplete market; explicit correction required');
   if(existing.rows.find(e=>e.id===lockedHistory.snapshots[0].snapshotId)?.registryId===roster.id)throw Error('Correction requires a new approved roster revision');
   const approved=await client.query('SELECT 1 FROM "V2AllocationPlan" WHERE "marketId"=$1 AND status=\'AUTHORITATIVE\'',[market]);if(approved.rowCount)throw Error('Correction blocked after authoritative plan');
   supersedesId=lockedHistory.snapshots[0].snapshotId;
  }
  await client.query('INSERT INTO "V2Snapshot"(id,"marketId","intervalStart","intervalEnd","sourceIdentity","sourceVersion","configHash","payloadHash","schemaVersion","expectedCount","actualCount",completeness,"collectedAt",status,"supersedesId") VALUES($1,$2,$3,$4,\'BACKEND_LOCAL_SIMULATOR\',\'1.0.0\',$5,$6,\'2.0.0\',$7,$7,$8,now(),\'PENDING\',$9)',[snapshot.snapshotId,market,timeSlot,end,configHash,hash,roster.users.length,JSON.stringify({registryId:roster.id}),supersedesId]);
  for(const u of snapshot.users)await client.query('INSERT INTO "V2SnapshotMeasurement"("snapshotId","marketId","userId","productionWh","consumptionWh") VALUES($1,$2,$3,$4,$5)',[snapshot.snapshotId,market,u.userId,u.productionWh,u.consumptionWh]);
  const check=await client.query('SELECT count(*)::int AS n,"v2_snapshot_measurement_hash"($1) AS hash FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1',[snapshot.snapshotId]);if(check.rows[0].n!==roster.users.length||check.rows[0].hash!==hash)throw Error('Persisted measurements do not match source');
  await client.query('UPDATE "V2Snapshot" SET status=\'FINALIZED\',"finalizedAt"=now(),finalizer=\'B22_LOCAL_GENERATOR_V1\' WHERE id=$1',[snapshot.snapshotId]);
  await client.query('INSERT INTO "B22Ingestion"(id,"marketId","snapshotId","registryId","sourceIdentity","sourceVersion",principal,"configHash","executableHash","payloadHash","contentDigest",payload,result) VALUES($1,$2,$3,$4,\'BACKEND_LOCAL_SIMULATOR\',\'1.0.0\',\'b22_ingest\',$5,$6,$7,$8,$9,\'FINALIZED\')',[randomUUID(),market,snapshot.snapshotId,roster.id,configHash,executableHash,hash,contentDigest,JSON.stringify(snapshot)]);
  await client.query('UPDATE "V2Market" SET status=\'FINALIZED\',"updatedAt"=now() WHERE id=$1',[market]);
  await client.query('COMMIT');return {marketId:market,snapshotId:snapshot.snapshotId,payloadHash:hash,reused:false};
 } catch(error){await client.query('ROLLBACK');throw error;}
}
