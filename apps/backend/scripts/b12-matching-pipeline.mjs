/**
 * B12: verify B11 snapshot against B09 PostgreSQL -> Python matching CLI ->
 * B05 schema and source-allocation validation -> optional atomic matching commit.
 *
 * Run from apps/backend, Node 22+:
 * node --env-file=../../.env scripts/b12-matching-pipeline.mjs --snapshot <B11 snapshot.json>
 * Defaults to NO DB writes; never invokes Hedera, contracts or private-key APIs.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStoredSnapshot } from './b11-pipeline-core.mjs';
import { verifyPersistedFile } from './b11-verify.mjs';
import {
  assertMatchingBusinessRules, compareStoredMatches, hashValue,
  makeMatchingInput, parseB12Args, requireB12Confirmation,
  stableMatchingResult, verifyBatchFingerprint,
} from './b12-matching-core.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

function runPython(python, args, timeoutMs) {
  const env = {
    ...process.env,
    PYTHONPATH: [join(repoRoot, 'packages/shared/python'),
      join(repoRoot, 'services/matching-engine'), process.env.PYTHONPATH]
      .filter(Boolean).join(delimiter),
  };
  const result = spawnSync(python, args, {
    env, cwd: repoRoot, timeout: timeoutMs, windowsHide: true,
    encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`Matching Python process failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Matching Python process exited ${result.status ?? result.signal}: ${String(result.stderr ?? '').slice(0, 1000)}`);
  // Diagnostics only, no wallet keys or credentials are returned by the matching CLI.
  if (result.stderr?.trim()) console.log(result.stderr.trim().slice(0, 1200));
}

async function verifyTrustedFingerprintReadOnly(snapshot) {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import('@prisma/adapter-pg'), import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const batch = await prisma.energySnapshotImport.findUnique({ where: { id: snapshot.snapshotId } });
    verifyBatchFingerprint(snapshot, batch);
  } finally {
    await prisma.$disconnect();
  }
}

async function persistMatching(snapshot, input, output, config, wantedRows) {
  const [{ PrismaPg }, { PrismaClient }, { Prisma }] = await Promise.all([
    import('@prisma/adapter-pg'),
    import('../dist/generated/prisma/client.js'),
    import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const configSha256 = hashValue(config);
  const resultSha256 = hashValue(stableMatchingResult(output));
  const timeSlot = new Date(snapshot.timeSlot);
  try {
    return await prisma.$transaction(async (tx) => {
      // Recheck under SERIALIZABLE isolation to protect against changed DB state
      // between the read-only B11 preflight and this commit.
      const [batch, energy, users] = await Promise.all([
        tx.energySnapshotImport.findUnique({ where: { id: snapshot.snapshotId } }),
        tx.energyRecord.findMany({ where: { snapshotId: snapshot.snapshotId } }),
        tx.user.findMany({ where: { id: { in: snapshot.users.map(u => u.userId) } },
          select: { id: true, wallet: { select: { evmAddress: true } } } }),
      ]);
      verifyBatchFingerprint(snapshot, batch);
      checkStoredSnapshot(snapshot, batch, energy, users);

      // One immutable matching run per hour. This also persists a NO-MATCH result.
      const existingRun = await tx.matchingRun.findUnique({ where: { timeSlot } });
      const rows = await tx.match.findMany({ where: { timeSlot } });
      if (existingRun) {
        if (existingRun.snapshotId !== snapshot.snapshotId ||
            existingRun.algorithmVersion !== input.algorithmVersion ||
            existingRun.configSha256 !== configSha256 ||
            existingRun.resultSha256 !== resultSha256 ||
            existingRun.matchCount !== output.matches.length ||
            existingRun.unmatchedBuyerCount !== output.unmatchedBuyerIds.length) {
          throw new Error('A different matching run already exists for this UTC hour. Do not overwrite it.');
        }
        compareStoredMatches(rows, wantedRows);
        return { created: 0, unchanged: rows.length, unmatched: existingRun.unmatchedBuyerCount };
      }
      if (rows.length !== 0) {
        throw new Error('Untracked or legacy matching rows occupy this hour; refuse a new matching run');
      }
      await tx.matchingRun.create({ data: {
        id: randomUUID(), snapshotId: snapshot.snapshotId, timeSlot,
        algorithmVersion: input.algorithmVersion, configSha256,
        resultSha256, matchCount: output.matches.length,
        unmatchedBuyerCount: output.unmatchedBuyerIds.length,
      } });
      if (wantedRows.length > 0) await tx.match.createMany({ data: wantedRows });
      const saved = await tx.match.findMany({ where: { timeSlot } });
      compareStoredMatches(saved, wantedRows);
      return { created: wantedRows.length, unchanged: 0, unmatched: output.unmatchedBuyerIds.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const options = parseB12Args(process.argv.slice(2));
  requireB12Confirmation(options);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing. Start Node with --env-file=../../.env');

  // Import B05's existing contract validator and existing B04 match mapper.
  // Build first: pnpm --filter @energy-trading/backend build
  const [{ ContractValidator, assertMatchingOutputAgainstInput }, { toMatchData }] = await Promise.all([
    import('../dist/contracts/contract-validator.js'),
    import('../dist/contracts/contract-mappers.js'),
  ]);
  const validator = new ContractValidator();
  const [snapshotData, configData] = await Promise.all([
    readFile(options.snapshot, 'utf8'), readFile(options.config, 'utf8'),
  ]);
  const snapshot = validator.parse('energy-snapshot', JSON.parse(snapshotData));
  const config = validator.parse('matching-config', JSON.parse(configData));
  const input = validator.parse('matching-input', makeMatchingInput(snapshot, config, options.expectedUsers));
  const buyers = input.users.filter(u => u.marketRole === 'BUYER').length;
  const sellers = input.users.filter(u => u.marketRole === 'SELLER').length;
  if (buyers < 1 || sellers < 1) throw new Error('B12 needs at least one buyer and one seller in the imported snapshot');

  // Verify both B11 rows and B09's complete immutable payload hash on EVERY run,
  // including dry runs, so a modified location/price profile cannot be matched.
  await verifyPersistedFile(options.snapshot, { quiet: true });
  await verifyTrustedFingerprintReadOnly(snapshot);

  const artifactBase = options.artifactDir ?? tmpdir();
  await mkdir(artifactBase, { recursive: true });
  const artifacts = await mkdtemp(join(artifactBase, 'b12-matching-'));
  const inputFile = join(artifacts, 'matching-input.json');
  const outputFile = join(artifacts, 'matching-output.json');
  await writeFile(inputFile, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx' });
  console.log(`B12 PLAN: snapshot=${snapshot.snapshotId} UTC hour=${snapshot.timeSlot}; buyers=${buyers}, sellers=${sellers}; ${options.execute ? 'IMPORT REQUESTED' : 'DRY RUN'}`);
  console.log(`B12 ARTIFACTS: ${artifacts}`);

  runPython(options.python, ['-m', 'matching_engine.cli', '--input', inputFile,
    '--config', options.config, '--output', outputFile], options.timeoutMs);
  const output = assertMatchingOutputAgainstInput(validator, JSON.parse(await readFile(outputFile, 'utf8')), input);
  const counts = assertMatchingBusinessRules(input, output);
  const wantedRows = output.matches.map(toMatchData);
  console.log(`B12 VALIDATED: ${counts.matched} selected matches; ${counts.unmatched} unmatched buyers; no overselling`);
  console.log(`B12 OUTPUT: ${outputFile}`);
  if (!options.execute) {
    console.log('B12 DRY RUN PASS: zero matching records written. To persist, run again with --execute and B12_MATCH_IMPORT_CONFIRM=YES.');
    return;
  }
  const result = await persistMatching(snapshot, input, output, config, wantedRows);
  console.log(`B12 PERSISTED: created=${result.created}; unchanged=${result.unchanged}; unmatched=${result.unmatched}`);
  console.log('B12 PASS: B11 PostgreSQL -> Python matching -> B05 validation -> atomic PostgreSQL match persistence; NO Hedera transactions');
}

try {
  await main();
} catch (error) {
  console.error(`B12 FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error('No automatic retries. If a DB response is uncertain, inspect matching_runs and matches before re-executing.');
  process.exitCode = 1;
}
