/**
 * B28.1: read-only B11/B12 -> V2 candidate compatibility audit.
 * Place this file in apps/backend/scripts/ and run from repository root:
 *   node --env-file=apps/backend/.env apps/backend/scripts/b28-b11-v2-candidate.mjs
 *   node --env-file=apps/backend/.env apps/backend/scripts/b28-b11-v2-candidate.mjs --slot=2026-11-10T14:00:00Z
 * No changes to PostgreSQL, Hedera, or application files. This is NOT a V2 commit.
 */

export const DEFAULT_SLOT = '2026-11-10T14:00:00Z';
const HOUR = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):00:00Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const INT = /^-?\d+$/;
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);

export function asBig(value, label) {
  const str = String(value);
  if (value === null || value === undefined || !INT.test(str)) throw Error(`Invalid integer field: ${label}`);
  return BigInt(str);
}
export function expectedPayment(quantityWh, unitPriceMicrousdPerKwh) {
  const wh = asBig(quantityWh, 'quantityWh');
  const price = asBig(unitPriceMicrousdPerKwh, 'unitPriceMicrousdPerKwh');
  if (wh <= 0n || price <= 0n) throw Error('Nonpositive quantity or price');
  const value = wh * price;
  return { baseUnits: value / 1000n, remainder: value % 1000n };
}

export function auditData({ importRow, records, matchingRuns, matches, wallets, slot, existingV2 }) {
  const errors = []; const warnings = [];
  const fail = (code) => errors.push(code);
  const warn = (code) => warnings.push(code);
  const report = { slot, simulationOnly: true, readOnly: true, historicalMatchesAreNotV2Allocations: true };
  if (!importRow) fail('B11_IMPORT_ABSENT');
  if (!Array.isArray(records) || records.length !== 12) fail('EXPECTED_12_ENERGY_RECORDS');
  if (importRow && Number(importRow.record_count) !== records.length) fail('B11_IMPORT_COUNT_MISMATCH');
  if (existingV2 > 0) fail('V2_RECORDS_ALREADY_PRESENT_RECONCILE_FIRST');
  if (matchingRuns.length !== 1) fail('EXPECTED_ONE_B12_MATCHING_RUN');
  if (matchingRuns.length === 1 && Number(matchingRuns[0].match_count) !== matches.length) fail('B12_MATCH_COUNT_MISMATCH');

  const users = new Map(), walletsByUser = new Map(), usedWallets = new Set();
  for (const w of wallets) {
    const id = String(w.user_id ?? '').toLowerCase(), address = String(w.evm_address ?? '').toLowerCase();
    if (!UUID.test(id) || !EVM.test(address) || !String(w.hedera_account_id ?? '').match(/^0\.0\.\d+$/) ||
        walletsByUser.has(id) || usedWallets.has(address)) fail('INVALID_OR_DUPLICATE_WALLET');
    walletsByUser.set(id, w); usedWallets.add(address);
  }
  for (const row of records) {
    const id = String(row.user_id ?? '').toLowerCase();
    if (!UUID.test(id) || users.has(id)) { fail('INVALID_OR_DUPLICATE_ENERGY_USER'); continue; }
    users.set(id, row);
    if (!walletsByUser.has(id)) fail('HOUSEHOLD_WALLET_MISSING');
    if (importRow && row.snapshot_id !== importRow.id) fail('B11_SNAPSHOT_ID_MISMATCH');
    try {
      const production = asBig(row.production_wh, 'production_wh');
      const consumption = asBig(row.consumption_wh, 'consumption_wh');
      const net = asBig(row.net_energy_wh, 'net_energy_wh');
      if (production < 0n || consumption < 0n || net !== production - consumption) fail('ENERGY_CONSERVATION_FAILED');
      if (net > 0n) {
        if (row.market_role !== 'SELLER' || asBig(row.available_energy_wh, 'available_energy_wh') !== net) fail('SELLER_ENERGY_ROLE_MISMATCH');
      } else if (net < 0n) {
        if (row.market_role !== 'BUYER' || asBig(row.required_energy_wh, 'required_energy_wh') !== -net) fail('BUYER_ENERGY_ROLE_MISMATCH');
      } else if (row.market_role === 'BUYER' || row.market_role === 'SELLER') fail('ZERO_NET_ENERGY_MARKED_ACTIVE');
    } catch { fail('INVALID_ENERGY_QUANTITIES'); }
  }
  const buyerTotals = new Map(), sellerTotals = new Map(), candidateRows = [];
  for (const match of matches) {
    const buyerId = String(match.buyer_id ?? '').toLowerCase();
    const sellerId = String(match.seller_id ?? '').toLowerCase();
    const buyer = users.get(buyerId), seller = users.get(sellerId);
    if (!buyer || !seller || buyerId === sellerId) { fail('MATCH_USER_IDENTITY_INVALID'); continue; }
    if (buyer.market_role !== 'BUYER' || seller.market_role !== 'SELLER') fail('MATCH_ROLE_INVALID');
    if (String(match.status ?? '') !== 'SELECTED') warn('B12_MATCH_HAS_NON_SELECTED_STATUS');
    try {
      const {baseUnits, remainder} = expectedPayment(match.quantity_wh,match.unit_price_microusd_per_kwh);
      const quantity = asBig(match.quantity_wh, 'quantity_wh');
      const price = asBig(match.unit_price_microusd_per_kwh, 'unit_price_microusd_per_kwh');
      if (remainder !== 0n || baseUnits <= 0n) fail('PAYMENT_NOT_EXACT_IN_6_DECIMAL_TEUSD');
      if (asBig(match.total_amount_microusd,'total_amount_microusd') !== baseUnits) fail('B12_PAYMENT_AMOUNT_MISMATCH');
      if (seller.ask_price_microusd_per_kwh === null || price !== asBig(seller.ask_price_microusd_per_kwh,'seller_ask')) fail('SELLER_ASK_PRICE_MISMATCH');
      if (buyer.max_price_microusd_per_kwh === null || price > asBig(buyer.max_price_microusd_per_kwh,'buyer_max')) fail('BUYER_PRICE_CAP_EXCEEDED');
      if (seller.energy_type !== match.seller_energy_type) fail('SELLER_ENERGY_TYPE_MISMATCH');
      buyerTotals.set(buyerId, (buyerTotals.get(buyerId) ?? 0n) + quantity);
      sellerTotals.set(sellerId, (sellerTotals.get(sellerId) ?? 0n) + quantity);
      candidateRows.push({ matchId: match.id, buyer: buyerId.slice(0,8), seller: sellerId.slice(0,8), quantityWh:String(quantity), teusd: `${baseUnits / 1000000n}.${(baseUnits % 1000000n).toString().padStart(6,'0')}`, exact:remainder===0n });
    } catch { fail('INVALID_MATCH_PAYMENT_FIELDS'); }
  }
  for (const [id, total] of buyerTotals) {
    const b = users.get(id);
    try {
      const required = asBig(b.required_energy_wh, 'required_energy_wh');
      if (total > required) fail('BUYER_DEMAND_EXCEEDED');
      // V1 B22 policy: one allocation per buyer, satisfying full demand.
      if (total !== required) fail('B22_V1_BUYER_NOT_FULLY_SATISFIED');
    } catch { fail('BUYER_REQUIRED_ENERGY_INVALID'); }
  }
  for (const [id,total] of sellerTotals) {
    const s=users.get(id);
    try { if(total > asBig(s.available_energy_wh,'available_energy_wh')) fail('SELLER_CAPACITY_EXCEEDED'); }
    catch { fail('SELLER_AVAILABLE_ENERGY_INVALID'); }
  }
  for(const id of buyerTotals.keys()) if(matches.filter(x=>String(x.buyer_id).toLowerCase()===id).length!==1) fail('B22_V1_MULTIPLE_SELLERS_PER_BUYER');

  report.b11Import = importRow ? { id: importRow.id, generatorVersion: importRow.generator_version, schemaVersion: importRow.schema_version, records: Number(importRow.record_count) } : null;
  report.b12Matching = matchingRuns[0] ? {algorithmVersion: matchingRuns[0].algorithm_version, matchCount: matches.length} : null;
  report.energyRecords = records.length;
  report.provisionedWallets = walletsByUser.size;
  report.matches = candidateRows;
  report.checksNotYetPerformed = ['B11_ORIGINAL_JSON_SHA256_REPLAY', 'TRUSTED_PARTICIPANT_PROFILE_AT_HISTORICAL_HOUR', 'B22_MATCHING_CONFIGURATION_AND_PYTHON_REPLAY', 'DISTANCE_REPUTATION_AND_ENERGY_PREFERENCE_POLICY', 'HEDERA_BUYER_ALLOWANCE_AND_EIP712_SIGNATURE', 'V2_DATABASE_COMMIT'];
  if (importRow && importRow.generator_version !== '1.0.0') fail('UNSUPPORTED_B11_GENERATOR_VERSION_FOR_B22');
  if (importRow && importRow.schema_version !== '1.0.0') fail('UNSUPPORTED_B11_SCHEMA_VERSION_FOR_B22');
  if (matchingRuns[0] && matchingRuns[0].algorithm_version !== '1.0.0') warn('B12_ALGORITHM_VERSION_DIFFERS_FROM_B22_V1');
  report.errors = [...new Set(errors)]; report.warnings = [...new Set(warnings)];
  report.state = report.errors.length ? 'BLOCKED_FOR_V2' : 'B11_B12_PRECHECK_PASS_ONLY';
  return report;
}

const isDirect = process.argv[1] && new URL(import.meta.url).pathname.replaceAll('\\','/').toLowerCase().endsWith(process.argv[1].replaceAll('\\','/').toLowerCase().replace(/^.*\//,''));
if (isDirect) {
  const args=process.argv.slice(2);
  const allowed = args.every(x=>x.startsWith('--slot='));
  const slot = args.find(x=>x.startsWith('--slot='))?.slice(7) ?? DEFAULT_SLOT;
  if (!allowed || args.length>1 || !HOUR.test(slot) || !Number.isFinite(Date.parse(slot)) || new Date(slot).toISOString().replace('.000Z','Z')!==slot || Date.parse(slot)+3600000>Date.now()) {
    console.error('STOP: Supply one closed UTC hour as --slot=YYYY-MM-DDTHH:00:00Z');process.exitCode=1;
  } else if (!process.env.DATABASE_URL) {
    console.error('STOP: DATABASE_URL missing in apps/backend/.env');process.exitCode=1;
  } else {
    let client; let begun=false;
    try {
      const {default:pg}=await import('../node_modules/pg/lib/index.js');
      client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:12000,statement_timeout:8000,application_name:'mgl850-b28-b11-v2-candidate-read-only'});
      await client.connect();
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
      const identity=(await client.query('SELECT current_database() AS db,current_user AS db_user')).rows[0];
      if(identity.db!=='energy_trading') throw Error('Unexpected database (expected energy_trading)');
      const importRows=(await client.query('SELECT id, time_slot, schema_version, generator_version, payload_sha256,record_count FROM energy_snapshot_imports WHERE time_slot=$1',[slot])).rows;
      const records=(await client.query('SELECT user_id, snapshot_id, production_wh, consumption_wh, net_energy_wh, market_role, available_energy_wh, required_energy_wh, energy_type, ask_price_microusd_per_kwh,max_price_microusd_per_kwh FROM energy_records WHERE time_slot=$1 ORDER BY user_id',[slot])).rows;
      const matchingRuns=(await client.query('SELECT id, snapshot_id,algorithm_version,match_count FROM matching_runs WHERE time_slot=$1',[slot])).rows;
      const matches=(await client.query('SELECT id,buyer_id,seller_id,quantity_wh,unit_price_microusd_per_kwh,total_amount_microusd,seller_energy_type,status FROM matches WHERE time_slot=$1 ORDER BY id',[slot])).rows;
      const wallets=records.length ? (await client.query('SELECT user_id,evm_address,hedera_account_id FROM wallets WHERE user_id = ANY($1::uuid[])',[records.map(x=>x.user_id)])).rows : [];
      const v2=(await client.query('SELECT (SELECT count(*)::int FROM "V2Market" WHERE "intervalStart"=$1)+(SELECT count(*)::int FROM "V2Snapshot" WHERE "intervalStart"=$1) AS n',[slot])).rows[0].n;
      const report=auditData({importRow:importRows.length===1?importRows[0]:null,records,matchingRuns,matches,wallets,slot,existingV2:v2});
      if(importRows.length>1) report.errors.push('MULTIPLE_B11_IMPORTS');
      if(matchingRuns.length===1 && importRows.length===1 && matchingRuns[0].snapshot_id!==importRows[0].id)report.errors.push('B12_IMPORT_REFERENCE_MISMATCH');
      if(report.errors.length)report.state='BLOCKED_FOR_V2';
      console.log('=== B28.1 READ-ONLY LEGACY-TO-V2 CANDIDATE PRECHECK ===');
      console.log(`Database: ${identity.db} | Actor: ${identity.db_user} | Hour: ${slot}`);
      console.table(report.matches);
      console.log(JSON.stringify({...report,matches:undefined},null,2));
      console.log('No V2 rows, matching plans, token approvals or transactions were created.');
      if(report.errors.length)process.exitCode=2;
    } catch(error) {
      console.error('B28 AUDIT STOP:',error?.message??String(error));process.exitCode=1;
    } finally {
      if(client){if(begun)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
    }
  }
}
