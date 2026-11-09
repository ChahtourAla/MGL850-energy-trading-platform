// Export wallet-enriched registry using ONLY trusted B07 wallet DB records.
// This script will refuse to export until EVERY source user has a wallet.
// Usage: node --env-file=../../.env scripts/export-wallet-ready-registry.mjs <registry.json> <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const [, , input, output] = process.argv;
if (!input || !output) throw new Error('Provide source registry JSON path and output path');
if (resolve(input) === resolve(output)) throw new Error('Input and output paths must differ');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
const registry = JSON.parse(await readFile(input, 'utf8'));
if (!registry || !Array.isArray(registry.users) || registry.users.length === 0) {
  throw new Error('Expected a nonempty UserRegistry. Validate it with B05 before exporting.');
}
const ids = registry.users.map((u) => u.userId);
if (new Set(ids).size !== ids.length) throw new Error('Source registry contains duplicate user IDs');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
try {
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, email: true,
      wallet: { select: { hederaAccountId: true, evmAddress: true } },
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const missing = ids.filter((id) => !byId.get(id)?.wallet);
  if (missing.length > 0) {
    throw new Error(`${missing.length}/${ids.length} households have no verified B07 wallet. No output written. Provision them through a trusted wallet onboarding workflow; never generate fake account IDs.`);
  }
  const enriched = {
    ...registry,
    users: registry.users.map((u) => {
      const db = byId.get(u.userId);
      if (!db || db.email.toLowerCase() !== u.email.toLowerCase()) {
        throw new Error('Registry and database UUID/email identities differ; no output written');
      }
      if (u.evmAddress || u.hederaAccountId) {
        throw new Error('Source already asserts wallet identifiers; use the non-enriched B08 registry');
      }
      return { ...u, hederaAccountId: db.wallet.hederaAccountId, evmAddress: db.wallet.evmAddress };
    }),
  };
  // Exclusive create: cannot silently replace a trusted export.
  await writeFile(output, `${JSON.stringify(enriched, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`B09 PASS: exported ${enriched.users.length} wallet-ready households to ${output}`);
} finally {
  await prisma.$disconnect();
}
