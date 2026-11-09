/** Independent, read-only PostgreSQL verification. Supports uncertain HTTP responses. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStoredSnapshot } from './b11-pipeline-core.mjs';

export async function verifyPersistedFile(file, { quiet = false } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for read-only PostgreSQL verification');
  const snapshot = JSON.parse(await readFile(resolve(file), 'utf8'));
  // Defer Prisma imports so B11's pure Node tests don't need generated code.
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import('@prisma/adapter-pg'),
    import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const [batch, records, wallets] = await Promise.all([
      prisma.energySnapshotImport.findUnique({ where: { id: snapshot.snapshotId } }),
      prisma.energyRecord.findMany({ where: { snapshotId: snapshot.snapshotId } }),
      prisma.user.findMany({
        where: { id: { in: snapshot.users.map((user) => user.userId) } },
        select: { id: true, wallet: { select: { evmAddress: true } } },
      }),
    ]);
    const count = checkStoredSnapshot(snapshot, batch, records, wallets);
    if (!quiet) console.log(`B11 VERIFIED: ${count} exact energy records persisted in PostgreSQL for ${snapshot.timeSlot} (${snapshot.snapshotId})`);
    return count;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node --env-file=../../.env scripts/b11-verify.mjs <snapshot.json>');
    process.exitCode = 2;
  } else {
    try {
      await verifyPersistedFile(process.argv[2]);
    } catch (error) {
      console.error(`B11 VERIFY FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
