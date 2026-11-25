/**
 * B28.2 Testnet settlement writer lock-permission repair.
 * Narrow privilege grants; each grant justified by a failing rolled-back probe.
 * No wallet access, no Hedera calls, no permanent settlement journal entries.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { connect, getMarket } from './b28-hedera-db.mjs';
import { MARKET, TOKEN } from './b28-hedera-core.mjs';

const ROLE = 'b28_hedera_writer';
const CONTRACT = '0x1946713C8f6Ec56cb6c641F0d56a17B30EEd82dB';
const FIRST = '0xe6fbf2bb022c6d7b11b4a9831f53cc378ee912f29d34f98eb7e3bdc1b5719d99';
const EXPECTED = new Set([
  FIRST,
  '0xccfcdffc28c22806aaf27047dc00ca2815fe10d815fc98e7a167447c8e02c308',
  '0x24a3e81f81ea25e6e360f8a32565288bcc5743cfa1ade73235aa368a542731b6',
]);
// Hard-coded allow-list; never interpolate a database-supplied table name into SQL.
const ALLOWED = Object.freeze({
  V2Market: 'public."V2Market"',
  V2Allocation: 'public."V2Allocation"',
  V2AllocationPlan: 'public."V2AllocationPlan"',
  V2Snapshot: 'public."V2Snapshot"',
});
const mode = process.argv[2] ?? '--check';
if (!['--check', '--apply'].includes(mode) || process.argv.length > 3) {
  throw new Error('Allowed usage: --check OR --apply');
}

const c = await connect();
let tx = false;
let trialId = null;
const granted = [];

const privileges = async (name) => {
  const reg = ALLOWED[name];
  const { rows: [p] } = await c.query(`SELECT
    has_table_privilege($1, $2, 'SELECT') AS can_read,
    has_table_privilege($1, $2, 'UPDATE') AS can_update_entire_table,
    has_column_privilege($1, $2, 'id', 'UPDATE') AS can_lock_id,
    has_column_privilege($1, $2, 'status', 'UPDATE') AS can_update_status`,
  [ROLE, reg]);
  return p;
};

// SELECT FOR UPDATE requires UPDATE permission; grant only UPDATE(id).
const grantId = async (name) => {
  const p = await privileges(name);
  if (!p.can_read || p.can_update_entire_table || p.can_update_status) {
    throw new Error(`STOP: unsafe or missing baseline privileges for ${name}`);
  }
  if (p.can_lock_id) return;
  await c.query(`GRANT UPDATE ("id") ON TABLE ${ALLOWED[name]} TO ${ROLE}`);
  const after = await privileges(name);
  if (!after.can_lock_id || after.can_update_entire_table || after.can_update_status) {
    throw new Error(`STOP: inappropriate UPDATE privileges for ${name}`);
  }
  granted.push(name);
  console.log(`Limited lock privilege added: ${name}.id only`);
};

const ensureEnergyAdmin = async () => {
  const { rows: [r] } = await c.query('SELECT current_user AS actor');
  if (r.actor !== 'energy_admin') throw new Error('STOP: rollback did not restore admin role');
};

const journalTrial = async (a) => {
  const syntheticId = '0x' + randomBytes(32).toString('hex');
  const syntheticHash = '0x' + randomBytes(32).toString('hex');
  trialId = syntheticId;
  await c.query('SELECT id FROM public."V2Market" WHERE id=$1 FOR UPDATE', [MARKET]);
  await c.query('SELECT id FROM public."V2Allocation" WHERE id=$1 FOR UPDATE', [a.id]);
  await c.query(`INSERT INTO public."V2SettlementIntent"
    (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt")
    VALUES ($1,$2,$3,296,$4,$5,$6,'PLANNED',now())`,
  [syntheticId,a.id,MARKET,TOKEN.toLowerCase(),CONTRACT.toLowerCase(),a.amountBaseUnits]);
  await c.query(`INSERT INTO public."V2SettlementAttempt"
    (id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"recoveryMetadata","updatedAt")
    VALUES ($1,$2,1,'SIGNED',$3,'B28_APPROVAL',0,'{}'::jsonb,now())`,
  [randomUUID(),syntheticId,syntheticHash]);
  // Deliberately also exercise row-locks used during receipt/recovery.
  await c.query('SELECT id FROM public."V2SettlementIntent" WHERE id=$1 FOR UPDATE', [syntheticId]);
  await c.query('SELECT id FROM public."V2SettlementAttempt" WHERE "settlementId"=$1 FOR UPDATE', [syntheticId]);
};

try {
  const { rows: roles } = await c.query(`
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
      FROM pg_roles WHERE rolname=$1`, [ROLE]);
  if (roles.length !== 1 || roles[0].rolinherit ||
      ['rolcanlogin','rolsuper','rolcreatedb','rolcreaterole','rolbypassrls'].some(k => roles[0][k])) {
    throw new Error('STOP: expected restricted NOLOGIN NOINHERIT B28 role not found');
  }
  const view = await getMarket(c);
  if (view.market.id !== MARKET || view.allocations.length !== 3 ||
      view.allocations.some(a => !EXPECTED.has(a.id) || a.status !== 'VALIDATED')) {
    throw new Error('STOP: pinned three-allocation B28 market differs');
  }
  for (const a of view.allocations) {
    const { rows } = await c.query('SELECT id FROM public."V2SettlementIntent" WHERE "allocationId"=$1', [a.id]);
    if (rows.length !== 0) throw new Error('STOP: a settlement intent exists; reconcile first');
  }
  for (const name of Object.keys(ALLOWED)) {
    const p = await privileges(name);
    console.log(`${name}: SELECT=${p.can_read}, UPDATE(id)=${p.can_lock_id}, UPDATE(status)=${p.can_update_status}, UPDATE(table)=${p.can_update_entire_table}`);
    if (!p.can_read || p.can_update_entire_table || p.can_update_status) {
      throw new Error(`STOP: unsafe or missing baseline role privilege on ${name}`);
    }
  }
  if (mode === '--check') {
    console.log('READ ONLY: no changes. Existing settled/broadcast state must be independently reconciled.');
  } else {
    await c.query('BEGIN'); tx = true;
    await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='12s'");
    // The two known B21 intent trigger locks.
    await grantId('V2Market');
    await grantId('V2Allocation');

    let succeeded = false;
    // Each probe runs under the actual writer role and is rolled back *entirely*.
    // If a trigger needs another allowed table's row lock, test/justify its
    // UPDATE(id) permission with the exact insufficient-privilege exception.
    for (let attempt = 0; attempt <= Object.keys(ALLOWED).length; attempt++) {
      await c.query('SAVEPOINT b28_probe');
      let error = null;
      try {
        await c.query(`SET LOCAL ROLE ${ROLE}`);
        const { rows: [actor] } = await c.query('SELECT current_user AS actor');
        if (actor.actor !== ROLE) throw new Error('Restricted writer role was not activated');
        await journalTrial(view.allocations.find(a => a.id === FIRST));
      } catch (e) {
        error = e;
      }
      // Restore both the session role and any synthetic journal records.
      await c.query('ROLLBACK TO SAVEPOINT b28_probe');
      await c.query('RELEASE SAVEPOINT b28_probe');
      await ensureEnergyAdmin();
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM public."V2SettlementIntent" WHERE id=$1', [trialId]);
      if (n.n !== 0) throw new Error('STOP: trial journal was not rolled back');
      if (!error) { succeeded = true; break; }
      if (error.code !== '42501') {
        throw new Error(`STOP: journal probe failed for another reason: ${String(error.message).slice(0,160)}`);
      }
      const match = /^permission denied for table (\w+)$/i.exec(String(error.message));
      const name = match?.[1];
      if (!name || !Object.hasOwn(ALLOWED, name)) {
        throw new Error(`STOP: unexpected missing privilege in journal probe: ${String(error.message).slice(0,160)}`);
      }
      const before = await privileges(name);
      if (!before.can_read || before.can_lock_id) {
        throw new Error(`STOP: privilege failure on ${name} is not explained by a missing UPDATE(id); manual inspection required`);
      }
      await grantId(name);
    }
    if (!succeeded) throw new Error('STOP: journal probe did not pass with narrow permitted grants');
    for (const name of Object.keys(ALLOWED)) {
      const p = await privileges(name);
      if (!p.can_read || p.can_update_entire_table || p.can_update_status) {
        throw new Error(`STOP: unsafe final privileges on ${name}`);
      }
    }
    await c.query('COMMIT'); tx = false;
    console.log(`PASS: rollback-only journal/row-lock trial; committed only narrowly scoped role grants: ${granted.join(', ') || '(none)'}`);
    console.log('PASS: no permanent settlement intents, attempts or Hedera broadcasts.');
  }
} catch (e) {
  if (tx) await c.query('ROLLBACK').catch(() => {});
  const message = String(e.message ?? e);
  console.error('STOP: repair rolled back or not started:', /postgres(?:ql)?:\/\/|password|private.?key/i.test(message) ? 'sensitive detail suppressed' : message);
  process.exitCode = 1;
} finally {
  await c.end();
}
