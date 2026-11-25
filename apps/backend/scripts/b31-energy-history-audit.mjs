/** B31: one-day, read-only audit of the two sources used by the demo chart.
 * Run from repository root:
 *   node --env-file=.env --env-file=apps/backend/.env apps/backend/scripts/b31-energy-history-audit.mjs --day=2026-11-10
 * This imports the existing B28 restricted-connection precheck and never signs or broadcasts.
 */
import { connect } from './b28-hedera-db.mjs';

const day = process.argv[2] ?? '--day=2026-11-10';
if (process.argv.length > 3 || !/^--day=\d{4}-\d{2}-\d{2}$/.test(day)) {
  throw new Error('Use --day=YYYY-MM-DD (UTC); for example --day=2026-11-10');
}
const startText = `${day.slice(6)}T00:00:00.000Z`;
const start = new Date(startText);
if (!Number.isFinite(start.getTime()) || start.toISOString() !== startText) {
  throw new Error('Invalid calendar day');
}
const end = new Date(start.getTime() + 24 * 3600_000);
const expected = Array.from({ length: 24 }, (_, hour) =>
  new Date(start.getTime() + hour * 3600_000).toISOString());
const iso = (value) => new Date(value).toISOString();
const database = await connect();
try {
  await database.query('BEGIN READ ONLY');
  const { rows: users } = await database.query(`
    SELECT id::text AS id, name
    FROM public.users
    WHERE account_origin = 'SIMULATED'
    ORDER BY name, id
  `);
  const { rows: v2 } = await database.query(`
    SELECT measurement."userId"::text AS "userId", snapshot."intervalStart" AS hour
    FROM public."V2SnapshotMeasurement" measurement
    JOIN public."V2Snapshot" snapshot ON snapshot.id = measurement."snapshotId"
      AND snapshot."marketId" = measurement."marketId"
    JOIN public."V2Market" market ON market.id = snapshot."marketId"
    WHERE snapshot.status = 'FINALIZED'
      AND market.namespace = 'hourly' AND market.mode = 'HOURLY'
      AND snapshot."intervalStart" >= $1 AND snapshot."intervalStart" < $2
      AND NOT EXISTS (
        SELECT 1 FROM public."V2Snapshot" correction
        WHERE correction."supersedesId" = snapshot.id
          AND correction.status = 'FINALIZED'
      )
    ORDER BY measurement."userId", snapshot."intervalStart"
  `, [start, end]);
  const { rows: legacy } = await database.query(`
    SELECT record.user_id::text AS "userId", record.time_slot AS hour
    FROM public.energy_records record
    JOIN public.energy_snapshot_imports imported ON imported.id = record.snapshot_id
    WHERE record.time_slot >= $1 AND record.time_slot < $2
    ORDER BY record.user_id, record.time_slot
  `, [start, end]);
  await database.query('ROLLBACK');

  const coverage = users.map((user) => {
    const v2Slots = v2.filter((row) => row.userId === user.id).map((row) => iso(row.hour));
    const legacySlots = legacy.filter((row) => row.userId === user.id).map((row) => iso(row.hour));
    const v2Set = new Set(v2Slots);
    const legacySet = new Set(legacySlots);
    const effective = new Set([...v2Set, ...legacySet]);
    return {
      household: user.name,
      v2FinalizedHours: v2Set.size,
      legacyImportedHours: legacySet.size,
      overlappingHours: [...v2Set].filter((h) => legacySet.has(h)).length,
      shownBeforeFix: v2Set.size > 0 ? v2Set.size : legacySet.size,
      shownAfterFix: effective.size,
      missingHoursUTC: expected.filter((h) => !effective.has(h)).map((h) => h.slice(11, 16)),
    };
  });
  console.log(JSON.stringify({
    mode: 'B31_HOURLY_ENERGY_READ_ONLY_AUDIT',
    database: 'energy_trading',
    utcDay: day.slice(6),
    expectedHoursPerHousehold: 24,
    registeredHouseholds: users.length,
    results: coverage,
    complete24HourHouseholds: coverage.filter((r) => r.shownAfterFix === 24).length,
    noDatabaseWrites: true,
    noBlockchainTransactions: true,
  }, null, 2));
  if (coverage.some((r) => r.shownAfterFix < 24)) {
    console.log('NOTE: Some hours are genuinely missing from both persisted sources. A code-only fix cannot create missing measurements. Use the B11 trusted import workflow for missing hours after validating source snapshots.');
  } else {
    console.log('PASS: All 24 hours exist in the combined trusted sources; the per-hour merge will make them visible.');
  }
} catch (error) {
  await database.query('ROLLBACK').catch(() => {});
  console.error(`B31 READ-ONLY AUDIT FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database.end();
}
