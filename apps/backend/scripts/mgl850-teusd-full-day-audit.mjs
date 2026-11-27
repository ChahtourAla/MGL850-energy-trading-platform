/**
 * MGL850: READ-ONLY comparison of imported energy, authoritative V2 allocations,
 * PostgreSQL settlement evidence, and actual Hedera Testnet TEUSD Transfer logs.
 *
 * Place at apps/backend/scripts/mgl850-teusd-full-day-audit.mjs and run from repo root:
 * node --env-file=.env --env-file=apps/backend/.env \
 *   apps/backend/scripts/mgl850-teusd-full-day-audit.mjs --day=2026-11-10
 *
 * NO DB WRITES. NO SIGNING. NO TRANSACTION BROADCAST.
 */
import { Interface, JsonRpcProvider } from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
const { default: pg } = await import('../node_modules/pg/lib/index.js');

const dayArg = process.argv.slice(2);
if (dayArg.length !== 1 || !/^--day=\d{4}-\d{2}-\d{2}$/.test(dayArg[0])) {
  console.error('Usage: --day=2026-11-10');
  process.exit(2);
}
const day = dayArg[0].slice(6);
const start = new Date(`${day}T00:00:00.000Z`);
if (Number.isNaN(start.getTime()) || start.toISOString().slice(0,10) !== day) {
  console.error('Invalid UTC day');
  process.exit(2);
}
const end = new Date(start.getTime() + 86_400_000);
const hourIndex = date => {
  const d = new Date(date);
  return (d.getTime() - start.getTime()) / 3_600_000;
};
const isHour = n => Number.isInteger(n) && n >= 0 && n <= 23;
const wallet = s => typeof s === 'string' && /^0x[a-f0-9]{40}$/i.test(s);
const txhash = s => typeof s === 'string' && /^0x[a-f0-9]{64}$/i.test(s);
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const transferInterface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']);
const reports = Array.from({length:24},(_,hour)=>({hourUTC:`${day}T${String(hour).padStart(2,'0')}:00:00Z`, importedSnapshots:0, importedHouseholds:0, historicalMatchingRuns:0, historicalB12Matches:0, finalizedV2Snapshots:0, v2Allocations:0, authorizedV2Allocations:0, verifiedHederaPayments:0, unverifiedOrMissingPayments:0}));

let db; let began=false;
try {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL missing (your local .env only)');
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname !== '/energy_trading' || decodeURIComponent(url.username) !== 'energy_admin') {
    throw Error('Refusing database other than local energy_trading as energy_admin');
  }
  db = new pg.Client({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000,query_timeout:20000,statement_timeout:15000,application_name:'mgl850-teusd-coverage-read-only'});
  await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began=true;
  const identity = (await db.query("SELECT current_database() AS db, session_user AS actor, current_setting('transaction_read_only') AS readonly")).rows[0];
  if (identity.db!=='energy_trading' || identity.actor!=='energy_admin' || identity.readonly!=='on') throw Error('Refusing unsafe database session');

  const args = [start.toISOString(),end.toISOString()];
  const [users,imports,legacy,matchRuns,b12Matches,v2Snapshots,allocations] = await Promise.all([
    db.query("SELECT u.id,u.name,w.evm_address AS address FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.account_origin='SIMULATED' ORDER BY u.name"),
    db.query('SELECT time_slot,record_count FROM energy_snapshot_imports WHERE time_slot >= $1 AND time_slot < $2 ORDER BY time_slot',args),
    db.query('SELECT time_slot,COUNT(DISTINCT user_id)::int AS n FROM energy_records WHERE time_slot >= $1 AND time_slot < $2 GROUP BY time_slot',args),
    db.query('SELECT time_slot,match_count FROM matching_runs WHERE time_slot >= $1 AND time_slot < $2',args),
    db.query('SELECT time_slot,COUNT(*)::int AS n FROM matches WHERE time_slot >= $1 AND time_slot < $2 GROUP BY time_slot',args),
    db.query(`SELECT s."intervalStart" AS hour,s.status FROM "V2Snapshot" s WHERE s."intervalStart">=$1 AND s."intervalStart"<$2`,args),
    db.query(`SELECT a.id,a."buyerId",a."sellerId",a."buyerAddress",a."sellerAddress",a."amountBaseUnits"::text AS amount,a."quantityWh"::text AS wh,a.status AS allocation_status,
       m."intervalStart" AS hour,m.status AS market_status,p.status AS plan_status,
       i.id AS intent_id,i.status AS intent_status,i."chainId" AS intent_chain,i."tokenAddress" AS intent_token,i."contractAddress" AS intent_contract,i."amountBaseUnits"::text AS intent_amount,
       e.id AS evidence_id,e."txHash" AS hash,e."receiptStatus" AS receipt_status,e."verificationStatus" AS evidence_status,e."buyerAddress" AS evidence_buyer,e."sellerAddress" AS evidence_seller,e."tokenAddress" AS evidence_token,e."contractAddress" AS evidence_contract,e."amountBaseUnits"::text AS evidence_amount
       FROM "V2Allocation" a
       JOIN "V2Market" m ON m.id=a."marketId"
       JOIN "V2AllocationPlan" p ON p.id=a."planId"
       LEFT JOIN "V2SettlementIntent" i ON i."allocationId"=a.id
       LEFT JOIN "V2SettlementEvidence" e ON e."settlementId"=i.id
       WHERE m."intervalStart">=$1 AND m."intervalStart"<$2
       ORDER BY m."intervalStart",a.id`,args)
  ]);

  const bump = (time,field,amount=1) => {
    const h=hourIndex(time);if(!isHour(h)) throw Error(`Non-hour-aligned timestamp encountered for ${field}`);
    reports[h][field]+=amount;
  };
  for (const r of imports.rows) bump(r.time_slot,'importedSnapshots');
  for (const r of legacy.rows) bump(r.time_slot,'importedHouseholds',r.n);
  for (const r of matchRuns.rows) bump(r.time_slot,'historicalMatchingRuns');
  for (const r of b12Matches.rows) bump(r.time_slot,'historicalB12Matches',r.n);
  for (const r of v2Snapshots.rows) if (r.status==='FINALIZED') bump(r.hour,'finalizedV2Snapshots');

  const grouped = new Map();
  for (const a of allocations.rows) {
    if (!grouped.has(a.id)) grouped.set(a.id,[]);
    grouped.get(a.id).push(a);
  }

  let rpc=null;
  const rpcUrl=process.env.HEDERA_JSON_RPC_URL;
  let chainNote='RPC_NOT_CONFIGURED';
  if (rpcUrl && /^https:\/\//.test(rpcUrl)) {
    try {
      rpc=new JsonRpcProvider(rpcUrl,296,{staticNetwork:true});
      const id=BigInt(await rpc.send('eth_chainId',[]));
      if (id!==296n) throw Error('RPC is not Hedera Testnet (chainId 296)');
      chainNote='HEDERA_TESTNET_RPC_VERIFIED';
    } catch { rpc=null; chainNote='RPC_UNAVAILABLE_OR_WRONG_CHAIN'; }
  }
  const txCheck = async a => {
    if (!a.evidence_id || !txhash(a.hash) || !rpc) return {verified:false,reason:!rpc?chainNote:'NO_VALID_EVIDENCE_HASH'};
    if (a.intent_status!=='CONFIRMED' || a.receipt_status!=='SUCCESS' || a.evidence_status!=='VERIFIED' || a.intent_chain!==296 ||
        !equal(a.intent_token,a.evidence_token) || !equal(a.intent_contract,a.evidence_contract) ||
        !equal(a.buyerAddress,a.evidence_buyer) || !equal(a.sellerAddress,a.evidence_seller) ||
        a.amount!==a.intent_amount || a.amount!==a.evidence_amount) return {verified:false,reason:'DATABASE_EVIDENCE_INCONSISTENT'};
    try {
      const receipt=await rpc.getTransactionReceipt(a.hash);
      if (!receipt || receipt.status!==1 || !equal(receipt.to,a.intent_contract)) return {verified:false,reason:'MISSING_OR_FAILED_CHAIN_RECEIPT'};
      const matches=[];
      for (const log of receipt.logs) {
        if (!equal(log.address,a.intent_token)) continue;
        try {
          const parsed=transferInterface.parseLog(log);
          if(parsed?.name==='Transfer'&&equal(parsed.args.from,a.buyerAddress)&&equal(parsed.args.to,a.sellerAddress)&&BigInt(parsed.args.amount)===BigInt(a.amount)) matches.push(log);
        } catch {}
      }
      if(matches.length!==1) return {verified:false,reason:`EXPECTED_ONE_TEUSD_TRANSFER_FOUND_${matches.length}`};
      const block=await rpc.getBlock(receipt.blockNumber);
      if(!block || !equal(block.hash,receipt.blockHash)) return {verified:false,reason:'BLOCK_CANONICALITY_MISMATCH'};
      return {verified:true,reason:'VERIFIED_HEDERA_TEUSD_TRANSFER'};
    } catch {return {verified:false,reason:'RPC_RECEIPT_CHECK_FAILED'};}
  };

  const allocationResults=[];
  for (const [id,rows] of grouped) {
    const a=rows[0]; bump(a.hour,'v2Allocations');
    const authoritative = a.plan_status==='AUTHORITATIVE' && a.allocation_status==='VALIDATED';
    if(authoritative) bump(a.hour,'authorizedV2Allocations');
    let check={verified:false,reason:authoritative?'NO_CONFIRMED_SETTLEMENT':'NOT_AUTHORITATIVE'};
    if(rows.length!==1) check={verified:false,reason:'DUPLICATE_EVIDENCE_ROWS'};
    else if(authoritative) check=await txCheck(a);
    if(authoritative) bump(a.hour,check.verified?'verifiedHederaPayments':'unverifiedOrMissingPayments');
    allocationResults.push({hourUTC:new Date(a.hour).toISOString(),allocationId:id,buyer:a.buyerAddress,seller:a.sellerAddress,energyWh:a.wh,TEUSD:((BigInt(a.amount)/1_000_000n).toString()+'.'+(BigInt(a.amount)%1_000_000n).toString().padStart(6,'0')),planStatus:a.plan_status,dbIntentStatus:a.intent_status??'NONE',txHash:a.hash??null,networkCheck:check.reason});
  }
  const households=users.rows.map(u=>({household:u.name,address:u.address??null,matchedAsBuyer:allocationResults.filter(a=>a.buyer && equal(a.buyer,u.address)).length,matchedAsSeller:allocationResults.filter(a=>a.seller && equal(a.seller,u.address)).length}));

  await db.query('ROLLBACK');began=false;
  console.log('\n=== MGL850 TEUSD FULL-DAY COVERAGE AUDIT (READ ONLY) ===');
  console.log(`Date UTC: ${day}; DB: ${identity.db}; chain: ${chainNote}`);
  console.table(reports);
  console.log('\n=== V2 ALLOCATIONS AND TRANSACTION VERIFICATION ===');
  console.table(allocationResults);
  console.log('\n=== REGISTERED SIMULATED HOUSEHOLDS ===');
  console.table(households.map(({household,address,matchedAsBuyer,matchedAsSeller})=>({household,address,matchedAsBuyer,matchedAsSeller})));
  const total = (field) => reports.reduce((s,x)=>s+x[field],0);
  const coverage={utcDay:day,simulatedHouseholds:users.rows.length,importedEnergyHours:reports.filter(r=>r.importedHouseholds>0).length,finalizedV2Hours:reports.filter(r=>r.finalizedV2Snapshots>0).length,historicalB12Matches:total('historicalB12Matches'),authoritativeV2Allocations:total('authorizedV2Allocations'),independentlyVerifiedHederaTeusdTransfers:total('verifiedHederaPayments'),unverifiedOrMissingPayments:total('unverifiedOrMissingPayments'),chainNote};
  console.log('\nSUMMARY:',JSON.stringify(coverage,null,2));
  console.log('IMPORTANT: Historical B12 matches are NOT automatically authorized or payable V2 allocations. Wallet funding/mints are separate from energy-trade settlements. Generated but unimported B11 files cannot be counted from PostgreSQL.');
  console.log('NO database writes, wallet signing, blockchain broadcasts, or token approvals occurred.');
  if(chainNote!=='HEDERA_TESTNET_RPC_VERIFIED') process.exitCode=3;
} catch (e) {
  const reason=String(e?.message??'Unknown error');
  console.error('STOP: AUDIT FAILED:',/postgres(?:ql)?:\/\/|password|private.?key|secret/i.test(reason)?'Configuration error (details suppressed)':reason);
  process.exitCode=1;
} finally {
  if(db){if(began)await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});}
}
