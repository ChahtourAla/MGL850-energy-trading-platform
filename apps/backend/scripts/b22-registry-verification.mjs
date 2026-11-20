/** Read-only source consistency checks. Caller must separately authorize the ingestion source. */
import {checkStoredSnapshot} from './b11-pipeline-core.mjs';
import {verifyBatchFingerprint} from './b12-matching-core.mjs';

/**
 * The caller supplies an already-connected PostgreSQL client and a separately
 * configured expected household set. This function does not attest that B09's
 * internal credential was used by the local simulator, and performs no writes.
 */
export async function verifyImportedSource(client,snapshot,expectedUserIds) {
  if(!Array.isArray(expectedUserIds)||!expectedUserIds.length||new Set(expectedUserIds).size!==expectedUserIds.length) throw Error('Trusted participant set missing or duplicated');
  const expected=[...expectedUserIds].sort(), actual=snapshot.users.map(u=>u.userId).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Snapshot differs from configured participant set');
  const batchResult=await client.query('SELECT id,time_slot AS "timeSlot",schema_version AS "schemaVersion",generator_version AS "generatorVersion",payload_sha256 AS "payloadSha256",record_count AS "recordCount" FROM energy_snapshot_imports WHERE id=$1',[snapshot.snapshotId]);
  if(batchResult.rows.length!==1)throw Error('Missing guarded energy import');
  verifyBatchFingerprint(snapshot,batchResult.rows[0]);
  const records=await client.query('SELECT id,user_id AS "userId",time_slot AS "timeSlot",production_wh AS "productionWh",consumption_wh AS "consumptionWh",net_energy_wh AS "netEnergyWh",market_role AS "marketRole",available_energy_wh AS "availableEnergyWh",required_energy_wh AS "requiredEnergyWh",energy_type AS "energyType",ask_price_microusd_per_kwh AS "askPriceMicrousdPerKwh",max_price_microusd_per_kwh AS "maxPriceMicrousdPerKwh",snapshot_id AS "snapshotId" FROM energy_records WHERE snapshot_id=$1',[snapshot.snapshotId]);
  const profiles=await client.query('SELECT u.id,w.evm_address AS "evmAddress",u.x_km AS "xKm",u.y_km AS "yKm",u.reputation,u.preferred_energy_type AS "preferredEnergyType" FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=ANY($1::uuid[])',[expected]);
  if(profiles.rows.length!==expected.length)throw Error('Expected registered user or wallet missing');
  const bigintFields=['productionWh','consumptionWh','netEnergyWh','availableEnergyWh','requiredEnergyWh','askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh'];
  for(const row of records.rows)for(const field of bigintFields)if(row[field]!==null)row[field]=BigInt(row[field]);
  checkStoredSnapshot(snapshot,batchResult.rows[0],records.rows,profiles.rows.map(p=>({id:p.id,wallet:{evmAddress:p.evmAddress}})));
  const byId=new Map(profiles.rows.map(p=>[p.id,p]));
  for(const user of snapshot.users){const p=byId.get(user.userId);if(!p||p.xKm===null||p.yKm===null||p.evmAddress.toLowerCase()!==user.evmAddress.toLowerCase()||Number(p.xKm)!==user.xKm||Number(p.yKm)!==user.yKm||p.reputation!==user.reputation||p.preferredEnergyType!==user.preferredEnergyType)throw Error('Snapshot differs from database registry profile');}
  return {registry:{users:profiles.rows.map(p=>({userId:p.id,evmAddress:p.evmAddress.toLowerCase(),xKm:Number(p.xKm),yKm:Number(p.yKm),reputation:p.reputation,preferredEnergyType:p.preferredEnergyType}))},sourceConsistencyVerified:true,sourceAuthorized:false};
}
