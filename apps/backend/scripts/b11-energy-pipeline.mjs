/**
 * B11: export trusted wallet identities -> generate hourly Python snapshot ->
 * B05 validate -> B09 internal API import -> read-only PostgreSQL verification.
 * No on-chain transactions. Dry-run by default.
 *
 * Run from apps/backend with Node 22+ and the repository's ignored .env loaded:
 * node --env-file=../../.env scripts/b11-energy-pipeline.mjs --registry <B08 JSON> --time-slot 2026-11-09T12:00:00Z
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportResult, checkSnapshot, consumptionOnlyUserIds, parseArgs, validateRegistry } from './b11-pipeline-core.mjs';
import { verifyPersistedFile } from './b11-verify.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scripts, '..');
const repoRoot = resolve(backendDir, '../..');

function executeCommand(program, args, env) {
  const child = spawnSync(program, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (child.error) throw new Error(`Could not start ${program}: ${child.error.message}`);
  if (child.status !== 0) throw new Error(`${program} exited with status ${child.status ?? child.signal}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL. Start with node --env-file=../../.env');
  if (options.execute && (process.env.B11_IMPORT_CONFIRM !== 'YES' ||
      !process.env.INTERNAL_IMPORT_API_KEY || process.env.INTERNAL_IMPORT_API_KEY.length < 32)) {
    throw new Error('Import disabled. Set B11_IMPORT_CONFIRM=YES explicitly and configure INTERNAL_IMPORT_API_KEY (32+ characters).');
  }
  const source = await readJson(options.registry);
  const total = validateRegistry(source, options.maxUsers);
  if (total !== options.expectedUsers) {
    throw new Error(`Expected exactly ${options.expectedUsers} imported B08 households, found ${total}; refusing partial energy import`);
  }
  if (options.consumptionOnlyCount >= total) {
    throw new Error(`Only ${total} households exist; --consumption-only-count must be less than ${total}`);
  }

  const artifactBase = options.artifactDir ?? tmpdir();
  await mkdir(artifactBase, { recursive: true });
  const folder = await mkdtemp(join(artifactBase, 'b11-energy-'));
  const walletReady = join(folder, 'wallet-ready-registry.json');
  const snapshotDir = join(folder, 'snapshots');
  const snapshotPath = join(snapshotDir, `energy_snapshot_${options.timeSlot.slice(0, 13)}.json`);
  const pythonEnv = {
    ...process.env,
    PYTHONPATH: [join(repoRoot, 'packages/shared/python'), join(repoRoot, 'services/data-generator'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  console.log(`B11 ARTIFACTS: ${folder}`);
  console.log(`B11 PLAN: ${total} existing households, hour ${options.timeSlot}; ${options.consumptionOnlyCount} deterministic consumption-only; ${options.execute ? 'IMPORT REQUESTED' : 'DRY RUN'}`);

  // Only B09 exporter is authorized to populate claimed addresses from trusted DB wallets.
  executeCommand(process.execPath, [join(scripts, 'export-wallet-ready-registry.mjs'), options.registry, walletReady], process.env);
  const registry = await readJson(walletReady);
  if (validateRegistry(registry, options.maxUsers, { requireWallets: true }) !== total) {
    throw new Error('Wallet-ready registry has a different household count');
  }
  executeCommand(options.python, ['-m', 'data_generator.cli', 'validate-users', '--input', walletReady, '--require-wallets'], pythonEnv);
  executeCommand(process.execPath, [join(scripts, 'validate-contract.mjs'), 'user-registry', walletReady], process.env);

  const consumptionOnly = consumptionOnlyUserIds(registry, options.consumptionOnlyCount);
  const generatorArgs = [
    '-m', 'data_generator.cli', 'generate-snapshot',
    '--registry', walletReady,
    '--config', options.config,
    '--time-slot', options.timeSlot,
    '--output-dir', snapshotDir,
    ...consumptionOnly.flatMap((id) => ['--consumption-only-user-id', id]),
  ];
  executeCommand(options.python, generatorArgs, pythonEnv);
  executeCommand(process.execPath, [join(scripts, 'validate-contract.mjs'), 'energy-snapshot', snapshotPath], process.env);
  const snapshot = await readJson(snapshotPath);
  const market = checkSnapshot(snapshot, registry, options.timeSlot);
  console.log(`B11 GENERATED: ${market.total} records; SELLER=${market.sellers}, BUYER=${market.buyers}, NEUTRAL=${market.neutral}`);
  console.log(`B11 SNAPSHOT: ${snapshotPath}`);

  if (!options.execute) {
    console.log('B11 DRY RUN PASS: no energy records imported. To persist, rerun with --execute and B11_IMPORT_CONFIRM=YES.');
    return;
  }

  const response = await fetch(`${options.backendUrl}/internal/energy/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-key': process.env.INTERNAL_IMPORT_API_KEY },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error(`Backend returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    // B09 409 is intentional: an hour was already imported with different content/UUID.
    throw new Error(`B09 HTTP ${response.status}: ${String(result.message ?? result.error ?? 'import failed').slice(0, 300)}. Do not overwrite this hour.`);
  }
  checkImportResult(result, snapshot);
  console.log(`B11 IMPORTED: created=${result.created}; unchanged=${result.unchanged}; snapshot=${result.snapshotId}`);
  await verifyPersistedFile(snapshotPath);
  console.log('B11 PASS: complete Python -> B05 -> B09 -> PostgreSQL pipeline verified');
}

try {
  await main();
} catch (error) {
  console.error(`B11 FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error('If the HTTP result is uncertain, do not regenerate a different payload for this UTC hour. Use b11-verify.mjs on the printed snapshot path.');
  process.exitCode = 1;
}
