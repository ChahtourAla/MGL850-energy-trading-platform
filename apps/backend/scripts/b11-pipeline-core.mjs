/** Pure B11 orchestration rules; no database, network, or subprocess side effects. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENERGY_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../../../services/data-generator/config/energy-generation-config.json');

export const HOUR_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):00:00Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVM_PATTERN = /^0x[0-9a-f]{40}$/i;

export function requireHour(slot) {
  if (typeof slot !== 'string' || !HOUR_PATTERN.test(slot) ||
      !Number.isFinite(Date.parse(slot)) || new Date(slot).toISOString() !== slot.replace(/Z$/, '.000Z')) {
    throw new Error('Provide a real UTC hour formatted YYYY-MM-DDTHH:00:00Z (e.g. 2026-11-09T12:00:00Z)');
  }
  return slot;
}

function intOption(raw, name, min, max) {
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return Number(raw);
}

export function parseArgs(args) {
  const values = {};
  const allowed = new Set(['--registry', '--config', '--time-slot', '--python', '--backend-url', '--max-users', '--expected-users', '--consumption-only-count', '--artifact-dir']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') {
      if (values.execute) throw new Error('Duplicate --execute');
      values.execute = true;
      continue;
    }
    if (!allowed.has(arg) || values[arg] !== undefined || i + 1 >= args.length || args[i + 1].startsWith('--')) {
      throw new Error(`Unknown, duplicate, or missing value for argument: ${arg}`);
    }
    values[arg] = args[++i];
  }
  if (!values['--registry']) throw new Error('Provide --registry with the ORIGINAL B08 registry (without wallets)');
  if (!values['--time-slot']) throw new Error('Provide --time-slot explicitly');
  const backendUrl = (values['--backend-url'] ?? process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
  const parsed = new URL(backendUrl);
  if ((parsed.protocol !== 'https:' && !(
    parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  )) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Backend URL must be HTTPS or loopback HTTP with no embedded credentials');
  }
  const options = {
    registry: resolve(values['--registry']),
    config: resolve(values['--config'] ?? DEFAULT_ENERGY_CONFIG),
    timeSlot: requireHour(values['--time-slot']),
    python: values['--python'] ?? 'python',
    backendUrl,
    maxUsers: intOption(values['--max-users'] ?? '12', '--max-users', 1, 200),
    expectedUsers: intOption(values['--expected-users'] ?? '12', '--expected-users', 1, 200),
    consumptionOnlyCount: intOption(values['--consumption-only-count'] ?? '4', '--consumption-only-count', 0, 199),
    artifactDir: values['--artifact-dir'] ? resolve(values['--artifact-dir']) : undefined,
    execute: values.execute === true,
  };
  if (options.expectedUsers > options.maxUsers) throw new Error('--expected-users cannot exceed --max-users');
  return options;
}

export function validateRegistry(registry, maxUsers, { requireWallets = false } = {}) {
  if (!registry || !Array.isArray(registry.users) || registry.users.length === 0 || registry.users.length > maxUsers) {
    throw new Error(`Expected 1–${maxUsers} households in the UserRegistry`);
  }
  const ids = new Set();
  const emails = new Set();
  const wallets = new Set();
  for (const user of registry.users) {
    if (!UUID_PATTERN.test(user.userId)) throw new Error('Registry includes invalid userId');
    const email = String(user.email ?? '').toLowerCase();
    if (!email || ids.has(user.userId.toLowerCase()) || emails.has(email)) throw new Error('Registry contains missing or duplicate user identity');
    ids.add(user.userId.toLowerCase()); emails.add(email);
    if (requireWallets) {
      if (!/^0\.0\.\d+$/.test(user.hederaAccountId ?? '') || !EVM_PATTERN.test(user.evmAddress ?? '')) {
        throw new Error(`Household ${user.userId} has no verified wallet identifiers`);
      }
      const wallet = user.evmAddress.toLowerCase();
      if (wallets.has(wallet)) throw new Error('Duplicate EVM wallet in registry');
      wallets.add(wallet);
    } else if ('evmAddress' in user || 'hederaAccountId' in user) {
      throw new Error('Input must be the original B08 user registry, without asserted wallet identifiers');
    }
  }
  return registry.users.length;
}

export function consumptionOnlyUserIds(registry, count) {
  if (!Number.isInteger(count) || count < 0 || count >= registry.users.length) {
    throw new Error('consumption-only-count must be between 0 and number of households minus 1');
  }
  return registry.users.map((user) => user.userId).sort().slice(0, count);
}

export function checkSnapshot(snapshot, registry, timeSlot) {
  if (!snapshot || snapshot.timeSlot !== timeSlot || !UUID_PATTERN.test(snapshot.snapshotId ?? '') ||
      !Array.isArray(snapshot.users) || snapshot.users.length !== registry.users.length) {
    throw new Error('Generated snapshot has an unexpected ID, time slot, or record count');
  }
  const expected = new Map(registry.users.map((user) => [user.userId.toLowerCase(), user.evmAddress.toLowerCase()]));
  const seen = new Set();
  let sellers = 0, buyers = 0, neutral = 0;
  for (const row of snapshot.users) {
    const userId = String(row.userId ?? '').toLowerCase();
    if (seen.has(userId) || !expected.has(userId) || String(row.evmAddress ?? '').toLowerCase() !== expected.get(userId) || row.timeSlot !== timeSlot) {
      throw new Error('Snapshot user identity, wallet address or hourly timestamp does not match the registry');
    }
    seen.add(userId);
    if (row.marketRole === 'SELLER') sellers++;
    else if (row.marketRole === 'BUYER') buyers++;
    else if (row.marketRole === 'NEUTRAL') neutral++;
    else throw new Error('Invalid market role in snapshot');
    for (const field of ['productionWh', 'consumptionWh', 'netEnergyWh', 'availableEnergyWh', 'requiredEnergyWh']) {
      if (!Number.isSafeInteger(row[field])) throw new Error(`Unsafe numeric quantity in ${field}`);
    }
  }
  return { total: seen.size, sellers, buyers, neutral };
}

export function checkImportResult(result, snapshot) {
  const total = snapshot.users.length;
  if (!result || result.source !== 'energy-snapshot' || result.snapshotId !== snapshot.snapshotId ||
      result.timeSlot !== snapshot.timeSlot || result.total !== total ||
      !Number.isInteger(result.created) || !Number.isInteger(result.unchanged) ||
      result.created + result.unchanged !== total || !(
        (result.created === total && result.unchanged === 0) ||
        (result.created === 0 && result.unchanged === total)
      )) {
    throw new Error('Backend import response does not match the generated snapshot');
  }
  return result;
}

export function checkStoredSnapshot(snapshot, batch, records, wallets) {
  if (!batch || batch.id !== snapshot.snapshotId || batch.timeSlot.getTime() !== new Date(snapshot.timeSlot).getTime() ||
      batch.recordCount !== snapshot.users.length || batch.schemaVersion !== snapshot.schemaVersion ||
      batch.generatorVersion !== snapshot.generatorVersion || records.length !== snapshot.users.length) {
    throw new Error('PostgreSQL snapshot metadata or record count does not match generated data');
  }
  const storedById = new Map(records.map((row) => [row.id, row]));
  const walletById = new Map(wallets.map((user) => [user.id, user.wallet?.evmAddress?.toLowerCase()]));
  for (const wanted of snapshot.users) {
    const row = storedById.get(wanted.recordId);
    if (!row || row.snapshotId !== snapshot.snapshotId || row.userId !== wanted.userId ||
        row.timeSlot.getTime() !== new Date(wanted.timeSlot).getTime() ||
        walletById.get(wanted.userId) !== wanted.evmAddress.toLowerCase()) {
      throw new Error(`Stored identity, wallet or time slot does not match for record ${wanted.recordId}`);
    }
    for (const field of ['productionWh', 'consumptionWh', 'netEnergyWh', 'availableEnergyWh', 'requiredEnergyWh', 'askPriceMicrousdPerKwh', 'maxPriceMicrousdPerKwh']) {
      if (wanted[field] === null) {
        if (row[field] !== null) throw new Error(`Stored ${field} does not match`);
      } else if (typeof row[field] !== 'bigint' || row[field] !== BigInt(wanted[field])) {
        throw new Error(`Stored ${field} does not match`);
      }
    }
    if (row.marketRole !== wanted.marketRole || row.energyType !== wanted.energyType) {
      throw new Error('Stored energy role or source differs from generated snapshot');
    }
  }
  return records.length;
}
