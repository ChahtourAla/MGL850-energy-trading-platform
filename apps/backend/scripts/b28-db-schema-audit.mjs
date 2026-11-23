/** B28.1 schema readiness audit. READ ONLY; no migration, DDL, DML or Hedera. */
const allowedHost=new Set(['127.0.0.1','localhost','[::1]']);
function dbUrl(raw){
 if(!raw)throw Error('DATABASE_URL unavailable');
 let u;try{u=new URL(raw);}catch{throw Error('Invalid DATABASE_URL');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!allowedHost.has(u.hostname)||u.pathname!=='/energy_trading')throw Error('B28 audit only accepts local energy_trading DB');
 return raw;
}
async function main(){
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const client=new pg.Client({connectionString:dbUrl(process.env.DATABASE_URL),connectionTimeoutMillis:5000,query_timeout:15000,statement_timeout:12000,application_name:'mgl850-b28-schema-audit'});
 let active=false;
 try{
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); active=true;
  const identity=(await client.query("SELECT current_database() AS database, current_user AS actor, current_setting('transaction_read_only') AS read_only")).rows[0];
  if(identity.database!=='energy_trading'||identity.read_only!=='on')throw Error('Read-only transaction enforcement failed');
  const constraint=(await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='V2Allocation_terms_check' AND conrelid='\"V2Allocation\"'::regclass")).rows;
  const guardRows=(await client.query("SELECT tgname AS name FROM pg_trigger WHERE tgrelid = '\"V2Allocation\"'::regclass AND NOT tgisinternal ORDER BY tgname")).rows;
  const role=(await client.query("SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='b28_market_writer'")).rows[0]??null;
  const counts={};
  for(const [name,table] of [['markets','V2Market'],['snapshots','V2Snapshot'],['plans','V2AllocationPlan'],['allocations','V2Allocation'],['positions','V2Position']]){
   const {rows:[r]}=await client.query(`SELECT count(*)::integer AS n FROM "${table}"`);
   counts[name]=r.n;
  }
  const b28PricingConstraint=constraint.length===1&&constraint[0].definition.includes('b28-teusd-half-even-1');
  console.log('=== B28.1 DATABASE SCHEMA READINESS — READ ONLY ===');
  console.log(JSON.stringify({identity,migration:{constraintPresent:constraint.length===1,b28PricingConstraint,legacyConstraint:constraint.length===1&&!b28PricingConstraint},role:role?{name:role.rolname,loginEnabled:role.rolcanlogin,superuser:role.rolsuper,bypassRLS:role.rolbypassrls}:null,v2Counts:counts,allocationGuards:guardRows.map(r=>r.name),summary:b28PricingConstraint?'B28 migration already present; check applied migrations and role before considering commit':'B28 migration not yet installed; do not commit'},null,2));
  console.log('AUDIT PASS: PostgreSQL transaction was READ ONLY. No migration or wallet/blockchain operations.');
 }finally{
  if(active)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
 }
}
main().catch(e=>{console.error('B28 AUDIT STOP:',e?.message??String(e));process.exitCode=1;});
