/** Runs only in the marked, disposable PostgreSQL database created by the B22 harness. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {verifyImportedSource} from '../apps/backend/scripts/b22-registry-verification.mjs';
import {importedSnapshotDigest} from '../apps/backend/scripts/b12-matching-core.mjs';
const require=createRequire(new URL('../apps/backend/package.json',import.meta.url)),{Client}=require('pg');
const raw=process.env.B22_TEST_DATABASE_URL;if(!raw)throw Error('B22_TEST_DATABASE_URL required');
const url=new URL(raw);if(url.hostname!=='127.0.0.1'||url.pathname!=='/b22_disposable_review'||url.username!=='b22test')throw Error('Refusing non-disposable target');
const client=new Client({connectionString:raw}), snapshot=JSON.parse(readFileSync(new URL('../packages/shared/fixtures/energy-snapshot.sample.json',import.meta.url)));
try {
 await client.connect();const marker=await client.query("SELECT current_database() AS name, EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') AS ok");assert.equal(marker.rows[0].name,'b22_disposable_review');assert.equal(marker.rows[0].ok,true);
 await client.query('BEGIN');
 for(const u of snapshot.users){
  await client.query('INSERT INTO users(id,name,email,password_hash,x_km,y_km,reputation,preferred_energy_type,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',[u.userId,'synthetic',u.userId+'@example.invalid','test',u.xKm,u.yKm,u.reputation,u.preferredEnergyType]);
  await client.query('INSERT INTO wallets(id,user_id,hedera_account_id,evm_address,public_key,encrypted_private_key,encryption_iv,encryption_auth_tag,updated_at) VALUES($1,$2,$3,$4,$5,$5,$5,$5,now())',[u.recordId,u.userId,'0.0.'+u.userId.slice(0,8),u.evmAddress,'synthetic']);
 }
 await client.query('INSERT INTO energy_snapshot_imports(id,time_slot,schema_version,generator_version,payload_sha256,record_count) VALUES($1,$2,$3,$4,$5,$6)',[snapshot.snapshotId,snapshot.timeSlot,snapshot.schemaVersion,snapshot.generatorVersion,importedSnapshotDigest(snapshot),snapshot.users.length]);
 for(const u of snapshot.users)await client.query('INSERT INTO energy_records(id,user_id,time_slot,production_wh,consumption_wh,net_energy_wh,market_role,available_energy_wh,required_energy_wh,energy_type,ask_price_microusd_per_kwh,max_price_microusd_per_kwh,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[u.recordId,u.userId,u.timeSlot,u.productionWh,u.consumptionWh,u.netEnergyWh,u.marketRole,u.availableEnergyWh,u.requiredEnergyWh,u.energyType,u.askPriceMicrousdPerKwh,u.maxPriceMicrousdPerKwh,snapshot.snapshotId]);
 const ids=snapshot.users.map(u=>u.userId),result=await verifyImportedSource(client,snapshot,ids);assert.equal(result.sourceConsistencyVerified,true);assert.equal(result.sourceAuthorized,false);
 await client.query('UPDATE energy_records SET production_wh=production_wh+1,net_energy_wh=net_energy_wh+1,available_energy_wh=available_energy_wh+1 WHERE id=$1',[snapshot.users[0].recordId]);await assert.rejects(verifyImportedSource(client,snapshot,ids),/productionWh/);
 await client.query('ROLLBACK');console.log('PASS real PostgreSQL guarded import, public registry and tampered measurement checks (synthetic fixture; transaction rolled back)');
} finally {await client.end();}
