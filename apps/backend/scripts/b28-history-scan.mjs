/**
 * B28.1 — READ ONLY scan of every B11 imported hour in persistent energy_trading.
 * NEVER writes B22/V2 state, makes wallet authorizations, or performs blockchain calls.
 * Requires b28-b11-v2-candidate.mjs in this directory. Uses backend local node_modules/pg.
 * Usage from repo root:
 *   node --env-file=apps/backend/.env apps/backend/scripts/b28-history-scan.mjs
 */
import {classifyHour,summarizeHours} from './b28-history-scan-core.mjs';
const pgModule=await import('../node_modules/pg/lib/index.js');
const pg=pgModule.default;

if(process.argv.length!==2){console.error('STOP: This scanner accepts no command-line arguments.');process.exit(1);}
if(!process.env.DATABASE_URL){console.error('STOP: DATABASE_URL missing');process.exit(1);}
const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:20000,statement_timeout:15000,application_name:'mgl850-b28-history-scan-READ-ONLY'});
let started=false;
try{
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  started=true;
  const identity=(await client.query('SELECT current_database() AS db,current_user AS actor,current_setting(\'transaction_read_only\') AS readonly')).rows[0];
  if(identity.db!=='energy_trading'||identity.readonly!=='on')throw Error('Refusing unexpected database or writable transaction');
  const imports=(await client.query('SELECT id,time_slot,schema_version,generator_version,payload_sha256,record_count FROM energy_snapshot_imports ORDER BY time_slot')).rows;
  const results=[];
  for(const imp of imports){
    const slot=new Date(imp.time_slot).toISOString().replace('.000Z','Z');
    const [recordsResult,runsResult,matchesResult,v2Result]=await Promise.all([
      client.query('SELECT user_id,snapshot_id,production_wh,consumption_wh,net_energy_wh,market_role,available_energy_wh,required_energy_wh,energy_type,ask_price_microusd_per_kwh,max_price_microusd_per_kwh FROM energy_records WHERE time_slot=$1 ORDER BY user_id',[imp.time_slot]),
      client.query('SELECT id,snapshot_id,algorithm_version,match_count FROM matching_runs WHERE time_slot=$1',[imp.time_slot]),
      client.query('SELECT id,buyer_id,seller_id,quantity_wh,unit_price_microusd_per_kwh,total_amount_microusd,seller_energy_type,status FROM matches WHERE time_slot=$1 ORDER BY id',[imp.time_slot]),
      client.query('SELECT (SELECT count(*)::int FROM "V2Market" WHERE "intervalStart"=$1)+(SELECT count(*)::int FROM "V2Snapshot" WHERE "intervalStart"=$1) AS n',[imp.time_slot]),
    ]);
    const records=recordsResult.rows;
    const wallets=records.length?(await client.query('SELECT user_id,evm_address,hedera_account_id FROM wallets WHERE user_id=ANY($1::uuid[])',[records.map(x=>x.user_id)])).rows:[];
    const row=classifyHour({slot,importRow:imp,records,matchingRuns:runsResult.rows,matches:matchesResult.rows,wallets,existingV2:Number(v2Result.rows[0].n)});
    if(runsResult.rows.length===1 && runsResult.rows[0].snapshot_id!==imp.id){row.errors.push('B12_IMPORT_REFERENCE_MISMATCH');row.status='BLOCKED';}
    results.push(row);
  }
  const summary=summarizeHours(results);
  console.log('=== B28.1 HISTORICAL HOUR CANDIDATE SCAN — READ ONLY ===');
  console.log(`Database: ${identity.db} | Actor: ${identity.actor} | Transaction read-only: ${identity.readonly}`);
  console.table(results.map(x=>({utcHour:x.slot,b12Matches:x.matches,nonExact:x.nonExact,state:x.status,blockers:x.errors.slice(0,3).join(',')||'—'})));
  console.log('Summary:',JSON.stringify(summary));
  const promising=results.filter(x=>x.status==='PRECHECK_PASS_ONLY');
  if(promising.length){
    console.log('PRELIMINARY CANDIDATES (NOT AUTHORITATIVE):',promising.map(x=>x.slot).join(', '));
    console.log('NEXT: Verify original B11 JSON SHA256, historical registry, Python replay, full V2 policy, and authorization before any V2 writes.');
  }else{
    const blocked=results.filter(x=>x.status==='BLOCKED'&&x.matches>0);
    console.log('NO PRELIMINARY PAYABLE CANDIDATE FOUND. Do not round or rewrite historical B12 data.');
    console.log('Review whether a new, separately versioned simulated hour and exact-payment policy is needed.');
    if(blocked.length){
      console.log('BLOCKED HOURS AND PAYMENT REMAINDERS:');
      for(const r of blocked)console.log(JSON.stringify({slot:r.slot,errors:r.errors,nonExactRemainders:r.remainders}));
    }
  }
  console.log('No PostgreSQL writes, new allocations, token approvals, or blockchain transactions were performed.');
}catch(error){
  console.error('SCAN STOP:',error?.message??String(error));process.exitCode=1;
}finally{
  if(started)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
}
