/** B28 restricted role repair for trigger FOR UPDATE; NO blockchain I/O.
 * Apply only to local energy_trading as energy_admin, and prove journal writes
 * in a rolled-back savepoint before committing the column-only grants.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { connect, getMarket } from './b28-hedera-db.mjs';
import { MARKET, TOKEN } from './b28-hedera-core.mjs';

const ROLE = 'b28_hedera_writer';
const CONTRACT = '0x1946713C8f6Ec56cb6c641F0d56a17B30EEd82dB';
const APPROVED = new Set([
  '0xe6fbf2bb022c6d7b11b4a9831f53cc378ee912f29d34f98eb7e3bdc1b5719d99',
  '0xccfcdffc28c22806aaf27047dc00ca2815fe10d815fc98e7a167447c8e02c308',
  '0x24a3e81f81ea25e6e360f8a32565288bcc5743cfa1ade73235aa368a542731b6',
]);
const mode = process.argv[2] ?? '--check';
if (!['--check', '--apply'].includes(mode) || process.argv.length > 3) {
  throw Error('Only --check or --apply is permitted');
}
const c = await connect();
let inTx = false;
try {
  const { rows: roles } = await c.query(`
    SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
    FROM pg_roles WHERE rolname=$1`, [ROLE]);
  if (roles.length !== 1 || Object.values(roles[0]).some(Boolean)) {
    throw Error('STOP: restricted NOLOGIN B28 role is missing or too powerful');
  }
  const view = await getMarket(c);
  if (view.market.id !== MARKET || view.allocations.length !== 3 ||
      view.allocations.some(a => !APPROVED.has(a.id)) ||
      view.allocations.some(a => a.status !== 'VALIDATED')) {
    throw Error('STOP: B28.1 market is not the pinned 3-allocation validated market');
  }
  for (const a of view.allocations) {
    const { rows } = await c.query('SELECT id FROM "V2SettlementIntent" WHERE "allocationId"=$1', [a.id]);
    if (rows.length) throw Error('STOP: existing settlement intent. Reconcile before further action.');
  }
  const privilegeState = async () => {
    const { rows: [p] } = await c.query(`SELECT
      has_table_privilege($1,'public."V2Market"','SELECT') as market_read,
      has_table_privilege($1,'public."V2Allocation"','SELECT') as allocation_read,
      has_column_privilege($1,'public."V2Market"','id','UPDATE') as market_id_update,
      has_column_privilege($1,'public."V2Allocation"','id','UPDATE') as allocation_id_update,
      has_column_privilege($1,'public."V2Market"','status','UPDATE') as market_status_update,
      has_column_privilege($1,'public."V2Allocation"','status','UPDATE') as allocation_status_update,
      has_table_privilege($1,'public."V2Market"','UPDATE') as market_full_update,
      has_table_privilege($1,'public."V2Allocation"','UPDATE') as allocation_full_update`, [ROLE]);
    if (!p.market_read || !p.allocation_read || p.market_status_update ||
        p.allocation_status_update || p.market_full_update || p.allocation_full_update) {
      throw Error('STOP: unexpected pre-existing role privileges; manual security review needed');
    }
    return p;
  };
  const current = await privilegeState();
  console.log('B28 restricted role permission check:', JSON.stringify(current));
  if (mode === '--check') {
    console.log('READ ONLY: no database change; no blockchain operation.');
    process.exitCode = (!current.market_id_update || !current.allocation_id_update) ? 2 : 0;
  } else {
    await c.query('BEGIN'); inTx = true;
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query("SET LOCAL statement_timeout = '12s'");
    // These facts have immutable ID guards. No UPDATE permission on status,
    // prices, wallets or any other columns is added.
    await c.query('GRANT UPDATE ("id") ON TABLE public."V2Market", public."V2Allocation" TO b28_hedera_writer');
    const after = await privilegeState();
    if (!after.market_id_update || !after.allocation_id_update) {
      throw Error('STOP: column-level lock privileges were not installed');
    }
    await c.query('SAVEPOINT b28_rollback_probe');
    await c.query('SET LOCAL ROLE b28_hedera_writer');
    const { rows: [who] } = await c.query('SELECT current_user actor');
    if (who.actor !== ROLE) throw Error('STOP: wrong journal writer role');
    const a = view.allocations.find(x => x.id ===
      '0xe6fbf2bb022c6d7b11b4a9831f53cc378ee912f29d34f98eb7e3bdc1b5719d99');
    await c.query('SELECT id FROM public."V2Market" WHERE id=$1 FOR UPDATE', [MARKET]);
    await c.query('SELECT id FROM public."V2Allocation" WHERE id=$1 FOR UPDATE', [a.id]);
    const syntheticId = '0x' + randomBytes(32).toString('hex');
    const syntheticTx = '0x' + randomBytes(32).toString('hex');
    // Exercise the same database journal triggers as execute; everything is
    // rolled back before we commit the grants.
    await c.query(`INSERT INTO public."V2SettlementIntent"
      (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt")
      VALUES ($1,$2,$3,296,$4,$5,$6,'PLANNED',now())`,
    [syntheticId,a.id,MARKET,TOKEN.toLowerCase(),CONTRACT.toLowerCase(),a.amountBaseUnits]);
    await c.query(`INSERT INTO public."V2SettlementAttempt"
      (id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"recoveryMetadata","updatedAt")
      VALUES ($1,$2,1,'SIGNED',$3,'B28_APPROVAL',0,'{}'::jsonb,now())`,
    [randomUUID(),syntheticId,syntheticTx]);
    await c.query('ROLLBACK TO SAVEPOINT b28_rollback_probe');
    await c.query('RELEASE SAVEPOINT b28_rollback_probe');
    const { rows: [whoAgain] } = await c.query('SELECT current_user actor');
    if (whoAgain.actor !== 'energy_admin') throw Error('STOP: session actor not restored');
    const { rows: [gone] } = await c.query('SELECT count(*)::int AS n FROM public."V2SettlementIntent" WHERE id=$1', [syntheticId]);
    if (gone.n !== 0) throw Error('STOP: rollback-only test row persisted');
    await c.query('COMMIT'); inTx = false;
    console.log('PASS: Only UPDATE(id) granted for immutable V2Market and V2Allocation.');
    console.log('PASS: Both FOR UPDATE locks and intent/attempt insert triggers passed in rolled-back trial.');
    console.log('PASS: Trial journal row rolled back; no settlement intents created; no Hedera transactions.');
  }
} catch (e) {
  if (inTx) await c.query('ROLLBACK').catch(() => {});
  const msg = String(e?.message ?? e);
  console.error('STOP: B28 role repair failed:', /password|postgres(?:ql)?:\/\//i.test(msg) ? 'Sensitive details suppressed' : msg);
  process.exitCode = 1;
} finally {
  await c.end();
}
