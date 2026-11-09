import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { ContractValidator } from '../contracts/contract-validator.js';
import type { UserRegistry } from '../contracts/types.js';
import { RegistryImportService } from './registry-import.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const fixturePath = new URL(
  '../../../../packages/shared/fixtures/user-registry.sample.json',
  import.meta.url,
);
const original = JSON.parse(readFileSync(fixturePath, 'utf8')) as UserRegistry;
const clone = (): UserRegistry => structuredClone(original);

type Row = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  accountOrigin: string;
  physicalAddress: string | null;
  xKm: Prisma.Decimal | null;
  yKm: Prisma.Decimal | null;
  preferredEnergyType: string | null;
  reputation: number;
};

const rows = new Map<string, Row>();

const mockUser = {
  findMany: async ({
    where,
  }: {
    where: {
      OR: [{ id: { in: string[] } }, { email: { in: string[] } }];
    };
  }) =>
    [...rows.values()].filter(
      (row) =>
        where.OR[0].id.in.includes(row.id) ||
        where.OR[1].email.in.some((email) => email.toLowerCase() === row.email.toLowerCase()),
    ),

  create: async ({ data }: { data: Record<string, unknown> }) => {
    const row = {
      ...data,
      id: data.id as string,
      email: data.email as string,
      xKm: new Prisma.Decimal(data.xKm as string),
      yKm: new Prisma.Decimal(data.yKm as string),
    } as Row;

    rows.set(row.id, row);
    return row;
  },

  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const prior = rows.get(where.id);

    if (!prior) {
      throw new Error('Row missing');
    }

    const row = {
      ...prior,
      ...data,
      xKm: new Prisma.Decimal(data.xKm as string),
      yKm: new Prisma.Decimal(data.yKm as string),
    } as Row;

    rows.set(where.id, row);
    return row;
  },
};

const db = {
  user: mockUser,

  $transaction: async <T>(run: (tx: { user: typeof mockUser }) => Promise<T>): Promise<T> =>
    run({ user: mockUser }),
};

const importer = new RegistryImportService(
  { client: db } as unknown as PrismaService,
  new ContractValidator(),
);

beforeEach(() => rows.clear());

describe('B08 user-registry import policies (mock PostgreSQL)', () => {
  it('inserts stable source UUIDs and disabled simulated credentials', async () => {
    const result = await importer.importRegistry(clone());
    expect(result).toEqual({
      source: 'user-registry',
      total: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      preservedRegistered: 0,
    });
    expect(rows.get(original.users[0].userId)?.accountOrigin).toBe('SIMULATED');
    expect(rows.get(original.users[0].userId)?.passwordHash).not.toMatch(/^\$argon2/);
  });

  it('reimporting identical data is idempotent', async () => {
    await importer.importRegistry(clone());
    const again = await importer.importRegistry(clone());
    expect(again.unchanged).toBe(2);
    expect(rows.size).toBe(2);
  });

  it('updates only allowed simulated profile fields', async () => {
    await importer.importRegistry(clone());
    const edit = clone();
    edit.users[0].reputation = 25;
    edit.users[0].name = 'Changed simulated house';
    const result = await importer.importRegistry(edit);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(rows.get(edit.users[0].userId)?.name).toBe('Changed simulated house');
    expect(rows.get(edit.users[0].userId)?.passwordHash).toBe('!SIMULATED_ACCOUNT_NO_LOGIN!');
  });

  it('preserves a REGISTERED account and its password hash', async () => {
    const profile = original.users[0];
    rows.set(profile.userId, {
      id: profile.userId,
      name: 'Real user name',
      email: profile.email,
      passwordHash: '$argon2id$SAVED',
      accountOrigin: 'REGISTERED',
      physicalAddress: 'Personal address',
      xKm: new Prisma.Decimal('6'),
      yKm: new Prisma.Decimal('7'),
      preferredEnergyType: 'ANY',
      reputation: 50,
    });
    const result = await importer.importRegistry(clone());
    expect(result.preservedRegistered).toBe(1);
    expect(result.created).toBe(1);
    expect(rows.get(profile.userId)?.passwordHash).toBe('$argon2id$SAVED');
    expect(rows.get(profile.userId)?.name).toBe('Real user name');
  });

  it('rejects a mismatched UUID for an existing email without writing', async () => {
    await importer.importRegistry(clone());
    const edit = clone();
    edit.users[0].userId = randomUUID();
    await expect(importer.importRegistry(edit)).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(2);
  });

  it('rejects a mismatched email for an existing UUID', async () => {
    await importer.importRegistry(clone());
    const edit = clone();
    edit.users[0].email = 'new@example.com';
    await expect(importer.importRegistry(edit)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects duplicate normalized emails', async () => {
    const edit = clone();
    edit.users[1].email = 'SOLAR@example.com';
    await expect(importer.importRegistry(edit)).rejects.toMatchObject({ status: 400 });
  });

  it('does not accept wallet identifiers from a file', async () => {
    const edit = clone();
    edit.users[0].hederaAccountId = '0.0.123';
    edit.users[0].evmAddress = '0x1234567890abcdef1234567890abcdef12345678';
    await expect(importer.importRegistry(edit)).rejects.toMatchObject({ status: 400 });
    expect(rows.size).toBe(0);
  });

  it('rejects malformed inputs and extra fields using B05 shared schema', async () => {
    await expect(
      importer.importRegistry({ schemaVersion: '1.0.0', users: [{ bad: true }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(importer.importRegistry({ ...clone(), unexpected: true })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects oversized registry batches before writing', async () => {
    const edit = clone();
    edit.users = Array.from({ length: 201 }, (_, i) => ({
      ...edit.users[0],
      userId: randomUUID(),
      email: `house${i}@example.invalid`,
    }));
    await expect(importer.importRegistry(edit)).rejects.toMatchObject({ status: 400 });
    expect(rows.size).toBe(0);
  });
});
