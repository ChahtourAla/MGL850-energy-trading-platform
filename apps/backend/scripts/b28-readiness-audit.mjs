/** B28 read-only readiness audit. Run from repository root:
 * node --env-file=apps/backend/.env apps/backend/scripts/b28-readiness-audit.mjs
 * Requires existing apps/backend/node_modules/pg installation.
 * NEVER creates a market run, matching plan, authorization, or blockchain transaction.
 */
import pg from '../node_modules/pg/lib/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('STOP: DATABASE_URL is missing. Check apps/backend/.env. No database operation attempted.');
  process.exitCode = 1;
} else {
  let client;
  let transactionStarted = false;
  try {
    const u = new URL(databaseUrl);
    if (!['postgresql:', 'postgres:'].includes(u.protocol)) throw new Error('DATABASE_URL must be PostgreSQL');
    client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
      query_timeout: 12000,
      statement_timeout: 8000,
      application_name: 'mgl850-b28-readiness-audit-read-only',
    });
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '8s'");
    const identity = (await client.query('SELECT current_database() AS database, current_user AS actor, current_schema() AS schema')).rows[0];
    console.log('=== B28 READ-ONLY PERSISTENT-DATABASE AUDIT ===');
    console.log(JSON.stringify({ database: identity.database, actor: identity.actor, schema: identity.schema, readonly: true }));

    // Only hardcoded, reviewed identifiers are used in SQL. Physical names for older Prisma
    // models can be mapped (e.g. energy_snapshot_imports and matching_runs).
    const targets = [
      { label: 'V2 markets', name: 'V2Market' },
      { label: 'V2 snapshots', name: 'V2Snapshot' },
      { label: 'V2 measurements', name: 'V2SnapshotMeasurement' },
      { label: 'V2 allocation plans', name: 'V2AllocationPlan' },
      { label: 'V2 allocations', name: 'V2Allocation' },
      { label: 'V2 positions', name: 'V2Position' },
      { label: 'B22 finalized-hour registries', name: 'B22HourlyRegistry' },
      { label: 'B22 archived ingestions', name: 'B22Ingestion' },
      { label: 'B26 coordinated runs', name: 'B26MarketRun' },
      { label: 'B11 energy imports', name: 'energy_snapshot_imports' },
      { label: 'B12 matching runs', name: 'matching_runs' },
    ];
    const present = new Map();
    const counts = [];
    for (const { label, name } of targets) {
      const quote = `"${name.replaceAll('"', '""')}"`;
      const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [quote])).rows[0].present;
      present.set(name, exists);
      const count = exists ? (await client.query(`SELECT count(*)::text AS n FROM ${quote}`)).rows[0].n : 'TABLE_NOT_PRESENT';
      counts.push({ source: label, table: name, rows: count });
    }
    console.table(counts);

    async function summarize(label, name, query) {
      if (!present.get(name)) return;
      console.log(`\n--- ${label} ---`);
      const rows = (await client.query(query)).rows;
      console.table(rows.length ? rows : [{ result: 'No records' }]);
    }
    await summarize('V2 market statuses', 'V2Market',
      'SELECT status, count(*)::text AS count FROM "V2Market" GROUP BY status ORDER BY status');
    await summarize('V2 snapshot statuses', 'V2Snapshot',
      'SELECT status, count(*)::text AS count FROM "V2Snapshot" GROUP BY status ORDER BY status');
    await summarize('V2 plan statuses', 'V2AllocationPlan',
      'SELECT status, count(*)::text AS count FROM "V2AllocationPlan" GROUP BY status ORDER BY status');
    await summarize('V2 allocation statuses', 'V2Allocation',
      'SELECT status, count(*)::text AS count FROM "V2Allocation" GROUP BY status ORDER BY status');
    await summarize('Recent V2 markets (metadata only)', 'V2Market',
      'SELECT id,mode,status,"intervalStart","intervalEnd" FROM "V2Market" ORDER BY "intervalStart" DESC LIMIT 5');
    await summarize('Recent V2 snapshots (metadata only)', 'V2Snapshot',
      'SELECT id,"marketId",status,"intervalStart","finalizedAt" FROM "V2Snapshot" ORDER BY "intervalStart" DESC LIMIT 5');
    await summarize('Recent B11 energy imports', 'energy_snapshot_imports',
      'SELECT "time_slot", "record_count" FROM energy_snapshot_imports ORDER BY "time_slot" DESC LIMIT 5');
    await summarize('Recent B12 matching runs', 'matching_runs',
      'SELECT "time_slot", "match_count" FROM matching_runs ORDER BY "time_slot" DESC LIMIT 5');

    console.log('\nAUDIT PASS: All queries completed in a PostgreSQL READ ONLY transaction. No data or blockchain writes.');
  } catch (error) {
    console.error('AUDIT STOP:', error?.message ?? String(error));
    process.exitCode = 1;
  } finally {
    if (client) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch { /* safe close */ }
      }
      await client.end().catch(() => {});
    }
  }
}
