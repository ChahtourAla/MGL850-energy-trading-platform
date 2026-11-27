/** B38.2: reviewed atomic V2 persistence; no RPC, signing, funding or payments. */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { slots, sha256, checkManifest, checkParity, review } from './b38-day-core.mjs';
import { sourcePreflight, getReadback } from './b28-v2-market.mjs';
import { runHourlyDryRun } from './b22-hourly-core.mjs';
import { makeB28Proposal, validateCommittedRows, buildB28Statements } from './b28-v2-core.mjs';
import { approvedMarketView } from './b33-review-core.mjs';
import { b28ProposalDigest } from './b28-commit-approval.mjs';
import { hashValue } from './b12-matching-core.mjs';
import { assertSafeRole, assertWriterIdentity, migrationMatches } from './b28-one-step-core.mjs';
import { verifyApproval, assertMeasurements } from './b38-commit-core.mjs';
const root = resolve(import.meta.dirname, '../../..');
async function main() {
  const args = {};
  for (const x of process.argv.slice(2)) {
    const m = /^--(day|day-dir|python|mode|confirm)=(.+)$/.exec(x);
    if (!m || Object.hasOwn(args, m[1]))
      throw Error(
        'Expected --day, --mode=trial|commit, --confirm=<review digest>, optional --day-dir and --python',
      );
    args[m[1]] = m[2];
  }
  const day = args.day;
  slots(day);
  if (!['trial', 'commit'].includes(args.mode) || !/^0x[0-9a-f]{64}$/.test(args.confirm ?? ''))
    throw Error('Explicit mode and reviewed digest required');
  const dir = resolve(
    args['day-dir'] ?? join(process.env.LOCALAPPDATA ?? '', 'MGL850', 'simulation-days', day),
  );
  const approved = JSON.parse(await readFile(join(dir, 'b38-v2-preview.json'), 'utf8'));
  verifyApproval(approved, approved, day, args.confirm);
  const rawManifest = await readFile(join(dir, 'preview-manifest.json'));
  const manifest = JSON.parse(rawManifest.toString('utf8').replace(/^\uFEFF/, ''));
  const rows = checkManifest(manifest, day);
  const cfg = JSON.parse(
    await readFile(join(root, 'packages/shared/fixtures/matching-config.sample.json'), 'utf8'),
  );
  const configHash = hashValue(cfg);
  const python =
    args.python ??
    join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/energy_trading' ||
    decodeURIComponent(url.username) !== 'energy_admin'
  )
    throw Error('Unexpected database target');
  const { default: pg } = await import('../node_modules/pg/lib/index.js');
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20000,
    query_timeout: 25000,
  });
  const hours = [],
    plans = [];
  let begun = false;
  try {
    await db.connect();
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    begun = true;
    const {
      rows: [identity],
    } = await db.query(
      "SELECT current_database() AS db,session_user AS actor,current_setting('transaction_read_only') AS ro",
    );
    if (
      identity.db !== 'energy_trading' ||
      identity.actor !== 'energy_admin' ||
      identity.ro !== 'off'
    )
      throw Error('Database identity guard failed');
    await db.query("SET LOCAL lock_timeout='5s'");
    const lock = (await db.query('SELECT pg_try_advisory_xact_lock(850,38) AS locked')).rows[0];
    if (!lock.locked) throw Error('Another B38 market commit is active');
    const roles = (
      await db.query(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='b28_market_writer'",
      )
    ).rows;
    if (roles.length !== 1) throw Error('Existing B28 restricted market writer required');
    assertSafeRole(roles[0]);
    const constraint = (
      await db.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='V2Allocation_terms_check' AND conrelid='\"V2Allocation\"'::regclass",
      )
    ).rows;
    if (constraint.length !== 1 || !migrationMatches(constraint[0].definition))
      throw Error('Existing B28 pricing migration required');
    for (const h of rows) {
      const raw = await readFile(join(dir, 'snapshots', h.filename));
      if (sha256(raw) !== h.sha256) throw Error('Snapshot hash mismatch ' + h.timeSlot);
      const snapshot = JSON.parse(raw.toString('utf8'));
      if (snapshot.timeSlot !== h.timeSlot || snapshot.users?.length !== 12)
        throw Error('Snapshot identity mismatch');
      const source = await sourcePreflight(db, snapshot);
      const runs = (await db.query('SELECT * FROM matching_runs WHERE time_slot=$1', [h.timeSlot]))
        .rows;
      const matches = (
        await db.query('SELECT * FROM matches WHERE time_slot=$1 ORDER BY id', [h.timeSlot])
      ).rows;
      if (
        runs.length !== 1 ||
        runs[0].snapshot_id !== snapshot.snapshotId ||
        Number(runs[0].match_count) !== matches.length ||
        runs[0].algorithm_version !== cfg.algorithmVersion ||
        runs[0].config_sha256 !== configHash
      )
        throw Error('Stored matching run mismatch ' + h.timeSlot);
      const legacy = await runHourlyDryRun(snapshot, source.registry, cfg, {
        sourcePolicy: 'LOCAL_SIMULATOR_V1',
        expectedUsers: 12,
        python,
        timeoutMs: 45000,
      });
      checkParity(matches, legacy.allocations);
      const conflict = (
        await db.query(
          `SELECT m.id FROM matches m WHERE m.time_slot=$1 AND (EXISTS (SELECT 1 FROM trades t WHERE t.match_id=m.id) OR EXISTS (SELECT 1 FROM b14_transaction_intents i WHERE i.match_id=m.id) OR EXISTS (SELECT 1 FROM b16_oracle_intents i WHERE i.match_id=m.id) OR EXISTS (SELECT 1 FROM b17_operator_intents i WHERE i.match_id=m.id))`,
          [h.timeSlot],
        )
      ).rows;
      if (conflict.length)
        throw Error('Legacy escrow activity exists; manual review required ' + h.timeSlot);
      let market = null;
      if (matches.length) {
        const plan = makeB28Proposal({ source, legacy, sourceId: snapshot.snapshotId });
        checkParity(matches, plan.allocations);
        market = approvedMarketView(
          { ...plan, proposalDigest: b28ProposalDigest(plan) },
          h.sha256,
          h.timeSlot,
        );
        if (source.existing.length) validateCommittedRows(plan, await getReadback(db, plan));
        plans.push({ plan, source, snapshot, slot: h.timeSlot });
      } else if (source.existing.length)
        throw Error('Unexpected V2 market in zero-match hour ' + h.timeSlot);
      hours.push({
        slot: h.timeSlot,
        snapshotId: snapshot.snapshotId,
        sourceSha256: h.sha256,
        matchCount: matches.length,
        market,
      });
      console.log(`PASS ${h.timeSlot}: ${matches.length} matches replayed`);
    }
    const result = review(day, hours, configHash, sha256(rawManifest));
    verifyApproval(approved, result, day, args.confirm);
    // Switch only after checking the legacy records with the existing admin read access.
    // Minimal read permission required by allocation integrity guards.
    await db.query(`
    GRANT SELECT ("allocationId")
    ON TABLE public."V2SettlementIntent"
    TO b28_market_writer
`);

    await db.query('SET LOCAL ROLE b28_market_writer');
    assertWriterIdentity(
      (
        await db.query(
          'SELECT current_database() AS db,current_user AS actor,session_user AS session_actor',
        )
      ).rows[0],
    );
    let created = 0,
      reused = 0;
    for (const { plan, source, snapshot, slot } of plans) {
      const fresh = await sourcePreflight(db, snapshot);
      if (
        fresh.marketId !== plan.marketId ||
        fresh.snapshotHash !== plan.snapshotHash ||
        fresh.importRow.id !== plan.snapshotId ||
        fresh.digest !== source.digest
      )
        throw Error('Source mismatch before commit');
      if (fresh.existing.length) {
        reused++;
      } else {
        for (const st of buildB28Statements(plan, {
          slot,
          configHash: '0x' + configHash,
          b11Import: fresh.importRow,
          b11Digest: fresh.digest,
        })) {
          const r = await db.query(st.sql, st.values);
          if (r.rowCount !== 1) throw Error('Unexpected market write count');
        }
        created++;
      }
      validateCommittedRows(plan, await getReadback(db, plan));
      const measurements = (
        await db.query(
          'SELECT "userId","productionWh","consumptionWh" FROM "V2SnapshotMeasurement" WHERE "snapshotId"=$1',
          [plan.snapshotId],
        )
      ).rows;
      assertMeasurements(plan.positions, measurements);
      console.log('PASS V2', slot, plan.allocations.length, 'allocations');
    }
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('RESET ROLE');
    const actual = (
      await db.query(
        `SELECT m.id AS market_id,a.id AS allocation_id FROM "V2Market" m LEFT JOIN "V2Allocation" a ON a."marketId"=m.id WHERE m.namespace='hourly' AND m.mode='HOURLY' AND m."intervalStart">=$1 AND m."intervalStart"<$2 ORDER BY m.id,a.id`,
        [day + 'T00:00:00Z', new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString()],
      )
    ).rows;
    const expected = plans
      .flatMap(({ plan }) => plan.allocations.map((a) => `${plan.marketId}|${a.id}`))
      .sort();
    const found = actual.map((a) => `${a.market_id}|${a.allocation_id}`).sort();
    if (JSON.stringify(expected) !== JSON.stringify(found))
      throw Error('Full-day V2 identity coverage mismatch');
    await db.query(args.mode === 'trial' ? 'ROLLBACK' : 'COMMIT');
    begun = false;
    console.log(
      'SUMMARY',
      JSON.stringify(
        {
          ...result.summary,
          createdMarkets: created,
          reusedMarkets: reused,
          reviewDigest: result.reviewDigest,
          mode: args.mode,
        },
        null,
        2,
      ),
    );
    console.log(
      args.mode === 'trial'
        ? 'PASS: All V2 writes rolled back; no permanent changes.'
        : 'PASS: All reviewed V2 markets committed atomically or reused.',
    );
    console.log('NO Hedera operations, funding, signatures or payments.');
  } finally {
    if (begun) await db.query('ROLLBACK').catch(() => {});
    await db.end().catch(() => {});
  }
}
main().catch((e) => {
  const s = String(e?.message ?? e);
  console.error(
    'B38 COMMIT STOP:',
    /postgres(?:ql)?:\/\/|private.?key|password|secret/i.test(s)
      ? 'Sensitive details suppressed'
      : s,
  );

  if (e?.code === '42501') {
    console.error('PostgreSQL error code:', e.code);
    console.error('PostgreSQL context:', e.where ?? 'Unavailable');
  }
  process.exitCode = 1;
});
