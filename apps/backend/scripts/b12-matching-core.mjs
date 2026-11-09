/** B12 pure matching orchestration rules; no DB, Python, or blockchain IO. */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHour } from './b11-pipeline-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_CONFIG = resolve(root, 'packages/shared/fixtures/matching-config.sample.json');
const MAX_HOUSEHOLDS = 200;
const argNames = new Set(['--snapshot', '--config', '--python', '--expected-users', '--artifact-dir', '--timeout-ms']);

function strictInteger(value, name, min, max) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

export function parseB12Args(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--execute') {
      if (values.execute) throw new Error('Duplicate --execute');
      values.execute = true;
      continue;
    }
    if (!argNames.has(item) || Object.hasOwn(values, item) || i === argv.length - 1 || argv[i+1].startsWith('--')) {
      throw new Error(`Unknown, repeated or missing option: ${item}`);
    }
    values[item] = argv[++i];
  }
  if (!values['--snapshot']) throw new Error('--snapshot is required: use the original B11 imported snapshot file');
  return {
    snapshot: resolve(values['--snapshot']),
    config: resolve(values['--config'] ?? DEFAULT_CONFIG),
    python: values['--python'] ?? 'python',
    expectedUsers: strictInteger(values['--expected-users'] ?? '12', '--expected-users', 1, MAX_HOUSEHOLDS),
    timeoutMs: strictInteger(values['--timeout-ms'] ?? '20000', '--timeout-ms', 1000, 120000),
    artifactDir: values['--artifact-dir'] ? resolve(values['--artifact-dir']) : undefined,
    execute: values.execute === true,
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashValue(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Identical to B09's digest normalization for snapshot payload, including user sorting. */
export function importedSnapshotDigest(snapshot) {
  return hashValue({ ...snapshot, users: [...snapshot.users].sort((a,b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) });
}

export function makeMatchingInput(snapshot, config, expectedUsers) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.users) ||
      snapshot.users.length !== expectedUsers || !snapshot.snapshotId) {
    throw new Error(`Snapshot must include exactly ${expectedUsers} canonical household records`);
  }
  requireHour(snapshot.timeSlot);
  if (config?.schemaVersion !== snapshot.schemaVersion || typeof config?.algorithmVersion !== 'string') {
    throw new Error('Matching config version must agree with snapshot schemaVersion');
  }
  const users = [...snapshot.users].sort((a,b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  return {
    schemaVersion: config.schemaVersion,
    snapshotId: snapshot.snapshotId,
    timeSlot: snapshot.timeSlot,
    algorithmVersion: config.algorithmVersion,
    maximumDistanceKm: config.maximumDistanceKm,
    scoringWeights: config.scoringWeights,
    users,
  };
}

/** Exclude nondeterministic CLI timestamps and benchmark duration from identity. */
export function stableMatchingResult(output) {
  return {
    schemaVersion: output.schemaVersion,
    snapshotId: output.snapshotId,
    timeSlot: output.timeSlot,
    algorithmVersion: output.algorithmVersion,
    matches: [...output.matches].map(({ createdAt, ...fields }) => fields)
      .sort((a,b) => a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0),
    unmatchedBuyerIds: [...output.unmatchedBuyerIds].sort(),
  };
}

export function assertMatchingBusinessRules(input, output) {
  const buyers = new Map(input.users.filter(u=>u.marketRole==='BUYER').map(u=>[u.userId,u]));
  const sellers = new Map(input.users.filter(u=>u.marketRole==='SELLER').map(u=>[u.userId,u]));
  const seen = new Set();
  const stock = new Map([...sellers].map(([id,s])=>[id,BigInt(s.availableEnergyWh)]));
  for (const m of output.matches) {
    const b = buyers.get(m.buyerId); const s = sellers.get(m.sellerId);
    if (!b || !s || seen.has(m.buyerId)) throw new Error('Output contains invalid or repeated buyer/seller identity');
    if (b.preferredEnergyType !== 'ANY' && b.preferredEnergyType !== s.energyType) {
      throw new Error('Output violates buyer energy-type preference');
    }
    if (m.quantityWh !== b.requiredEnergyWh || m.unitPriceMicrousdPerKwh !== s.askPriceMicrousdPerKwh ||
        m.unitPriceMicrousdPerKwh > b.maxPriceMicrousdPerKwh ||
        m.buyerWallet.toLowerCase() !== b.evmAddress.toLowerCase() ||
        m.sellerWallet.toLowerCase() !== s.evmAddress.toLowerCase()) {
      throw new Error('Output differs from original buyer/seller quantities, prices or wallets');
    }
    const remaining = stock.get(m.sellerId) - BigInt(m.quantityWh);
    if (remaining < 0n) throw new Error('Output oversells seller inventory');
    stock.set(m.sellerId, remaining);
    seen.add(m.buyerId);
  }
  const unmatched = new Set(output.unmatchedBuyerIds);
  if (unmatched.size !== output.unmatchedBuyerIds.length ||
      [...buyers.keys()].some(id => seen.has(id) === unmatched.has(id))) {
    throw new Error('Output has inconsistent unmatched buyers');
  }
  return { buyers: buyers.size, sellers: sellers.size, matched: output.matches.length, unmatched: unmatched.size };
}

function matchingAmountRow(row) {
  return {
    id: row.id, buyerId: row.buyerId, sellerId: row.sellerId,
    quantityWh: BigInt(row.quantityWh).toString(),
    unitPriceMicrousdPerKwh: BigInt(row.unitPriceMicrousdPerKwh).toString(),
    totalAmountMicrousd: BigInt(row.totalAmountMicrousd).toString(),
    distanceKm: Number(row.distanceKm), score: Number(row.score),
    sellerEnergyType: row.sellerEnergyType, algorithmVersion: row.algorithmVersion,
    timeSlot: new Date(row.timeSlot).toISOString(), status: row.status,
  };
}

/** Never silently accept changed SQL records just because the metadata still exists. */
export function compareStoredMatches(rows, wantedRows) {
  if (rows.length !== wantedRows.length) throw new Error('Stored matching row count differs from expected result');
  const byId = new Map(rows.map(row=>[row.id, matchingAmountRow(row)]));
  if (byId.size !== rows.length) throw new Error('Stored duplicate match IDs');
  for (const wanted of wantedRows) {
    const actual = byId.get(wanted.id);
    const expected = matchingAmountRow(wanted);
    if (!actual) throw new Error(`Stored match missing: ${wanted.id}`);
    for (const k of Object.keys(expected)) {
      if (k === 'distanceKm' || k === 'score') {
        if (!Number.isFinite(actual[k]) || Math.abs(actual[k] - expected[k]) > 1e-10) {
          throw new Error(`Stored match ${wanted.id} differs on ${k}`);
        }
      } else if (actual[k] !== expected[k]) {
        throw new Error(`Stored match ${wanted.id} differs on ${k}`);
      }
    }
  }
}

export function verifyBatchFingerprint(snapshot, batch) {
  if (!batch || batch.id !== snapshot.snapshotId || new Date(batch.timeSlot).getTime() !== new Date(snapshot.timeSlot).getTime() ||
      batch.recordCount !== snapshot.users.length || batch.schemaVersion !== snapshot.schemaVersion ||
      batch.generatorVersion !== snapshot.generatorVersion || batch.payloadSha256 !== importedSnapshotDigest(snapshot)) {
    throw new Error('Snapshot contents differ from B09 trusted PostgreSQL import fingerprint');
  }
}

export function requireB12Confirmation(options, env = process.env) {
  if (options.execute && env.B12_MATCH_IMPORT_CONFIRM !== 'YES') {
    throw new Error('Database writes are disabled: set B12_MATCH_IMPORT_CONFIRM=YES and pass --execute');
  }
}
