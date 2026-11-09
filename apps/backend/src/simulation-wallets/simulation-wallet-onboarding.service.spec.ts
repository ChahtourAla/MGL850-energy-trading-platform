import { beforeEach, describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SimulationWalletOnboardingService } from './simulation-wallet-onboarding.service.js';
import type { PublicWallet } from '../wallets/wallet.types.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const CONFIRM = `CREATE_TESTNET_ACCOUNT_FOR_${U1}`;

type UserRow = {
  id: string;
  accountOrigin: string;
  wallet: { hederaAccountId: string; evmAddress: string } | null;
  walletProvisioning: { state: string } | null;
};
const users = new Map<string, UserRow>();
const env = new Map<string, string>();
let created: string[];
let reconciled: string[];
const db = {
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }): Promise<UserRow[]> =>
      where.id.in.map((id) => users.get(id)).filter((row): row is UserRow => !!row),
    findUnique: async ({ where }: { where: { id: string } }): Promise<UserRow | null> =>
      users.get(where.id) ?? null,
  },
};
const config = { get: (key: string) => env.get(key) };
const wallets = {
  getPublicWallet: async (userId: string): Promise<PublicWallet> => {
    const u = users.get(userId)!;
    if (u.wallet) return { status: 'READY', ...u.wallet };
    if (u.walletProvisioning) return {
      status: u.walletProvisioning.state === 'NEEDS_RECONCILIATION'
        ? 'NEEDS_RECONCILIATION' : 'PROVISIONING',
    };
    return { status: 'NOT_PROVISIONED' };
  },
  provision: async (userId: string): Promise<PublicWallet> => {
    created.push(userId);
    users.get(userId)!.wallet = {
      evmAddress: '0x1111111111111111111111111111111111111111',
      hederaAccountId: '0.0.999',
    };
    return { status: 'READY', ...users.get(userId)!.wallet! };
  },
  reconcile: async (userId: string): Promise<PublicWallet> => {
    reconciled.push(userId);
    return { status: 'NEEDS_RECONCILIATION' };
  },
};
const onboarding = new SimulationWalletOnboardingService(
  { client: db } as never,
  wallets as never,
  config as never,
);

beforeEach(() => {
  users.clear(); env.clear();
  created = []; reconciled = [];
  users.set(U1, { id: U1, accountOrigin: 'SIMULATED', wallet: null, walletProvisioning: null });
  users.set(U2, { id: U2, accountOrigin: 'SIMULATED', wallet: {
    hederaAccountId: '0.0.222', evmAddress: '0x2222222222222222222222222222222222222222',
  }, walletProvisioning: null });
  users.set(U3, { id: U3, accountOrigin: 'SIMULATED', wallet: null, walletProvisioning: { state: 'NEEDS_RECONCILIATION' } });
  env.set('HEDERA_NETWORK', 'testnet');
  env.set('WALLET_PROVISIONING_ENABLED', 'true');
  env.set('SIMULATION_WALLET_ONBOARDING_ENABLED', 'true');
});

describe('B10 simulation wallet onboarding service', () => {
  it('previews the three account states without creating wallets', async () => {
    const plan = await onboarding.plan({ userIds: [U1, U2, U3] });
    expect(plan).toMatchObject({ total: 3, ready: 1, notProvisioned: 1, pending: 1 });
    expect(plan.users.map((row) => row.status)).toEqual([
      'NOT_PROVISIONED', 'READY', 'NEEDS_RECONCILIATION',
    ]);
    expect(created).toEqual([]);
  });
  it('rejects missing or extra plan fields', async () => {
    await expect(onboarding.plan({ userIds: [U1], bypass: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(onboarding.plan({})).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects duplicate user IDs', async () => {
    await expect(onboarding.plan({ userIds: [U1, U1.toUpperCase()] })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('limits each preflight plan to twelve households', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(onboarding.plan({ userIds: ids })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('does not accept unknown identities', async () => {
    await expect(onboarding.plan({ userIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('does not accept registered user identities in a plan', async () => {
    users.get(U1)!.accountOrigin = 'REGISTERED';
    await expect(onboarding.plan({ userIds: [U1] })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('requires a valid UUID', async () => {
    await expect(onboarding.plan({ userIds: ['../wallet'] })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('requires explicit confirmation for one specific account', async () => {
    await expect(onboarding.provision({ userId: U1, confirmation: 'YES' })).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toHaveLength(0);
  });
  it('rejects additional parameters that could change the wallet creation transaction', async () => {
    await expect(onboarding.provision({ userId: U1, confirmation: CONFIRM, initialHbar: 100 })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('never provisions while simulation onboarding is disabled', async () => {
    env.set('SIMULATION_WALLET_ONBOARDING_ENABLED', 'false');
    await expect(onboarding.provision({ userId: U1, confirmation: CONFIRM })).rejects.toBeInstanceOf(ForbiddenException);
    expect(created).toHaveLength(0);
  });
  it('never creates accounts on mainnet', async () => {
    env.set('HEDERA_NETWORK', 'mainnet');
    await expect(onboarding.provision({ userId: U1, confirmation: CONFIRM })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('requires the existing B07 provisioning feature gate', async () => {
    env.set('WALLET_PROVISIONING_ENABLED', 'false');
    await expect(onboarding.provision({ userId: U1, confirmation: CONFIRM })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('will not create wallets for registered accounts', async () => {
    users.get(U1)!.accountOrigin = 'REGISTERED';
    await expect(onboarding.provision({ userId: U1, confirmation: CONFIRM })).rejects.toBeInstanceOf(ForbiddenException);
    expect(created).toHaveLength(0);
  });
  it('returns an existing account without spending again', async () => {
    const result = await onboarding.provision({ userId: U2, confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${U2}` });
    expect(result).toMatchObject({ status: 'READY', userId: U2, hederaAccountId: '0.0.222' });
    expect(created).toHaveLength(0);
  });
  it('creates only the explicitly confirmed unprovisioned account', async () => {
    const result = await onboarding.provision({ userId: U1, confirmation: CONFIRM });
    expect(result).toMatchObject({ status: 'READY', userId: U1, hederaAccountId: '0.0.999' });
    expect(created).toEqual([U1]);
  });
  it('rejects another creation when an uncertain transaction is pending', async () => {
    await expect(onboarding.provision({ userId: U3, confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${U3}` }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(created).toHaveLength(0);
  });
  it('permits recovery even if new account creation is switched off', async () => {
    env.set('SIMULATION_WALLET_ONBOARDING_ENABLED', 'false');
    const result = await onboarding.reconcile({ userId: U3 });
    expect(result.status).toBe('NEEDS_RECONCILIATION');
    expect(reconciled).toEqual([U3]);
  });
  it('still requires B07 Testnet operations to be enabled for recovery', async () => {
    env.set('WALLET_PROVISIONING_ENABLED', 'false');
    await expect(onboarding.reconcile({ userId: U3 })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
