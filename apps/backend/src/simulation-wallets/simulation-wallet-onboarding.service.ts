import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { WalletsService } from '../wallets/wallets.service.js';
import type { PublicWallet, WalletPublicStatus } from '../wallets/wallet.types.js';

const MAX_PLAN_USERS = 12;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SimulationWalletStatus extends PublicWallet {
  userId: string;
}

export interface SimulationWalletPlan {
  total: number;
  ready: number;
  notProvisioned: number;
  pending: number;
  users: SimulationWalletStatus[];
}

function objectOnly(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Expected an object');
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(obj, key))) {
    throw new BadRequestException('Unexpected or missing request fields');
  }
  return obj;
}

function readUserId(raw: unknown): string {
  if (typeof raw !== 'string' || !USER_ID_PATTERN.test(raw)) {
    throw new BadRequestException('A valid user UUID is required');
  }
  return raw.toLowerCase();
}

function readPlan(raw: unknown): string[] {
  const obj = objectOnly(raw, ['userIds']);
  if (!Array.isArray(obj.userIds) || obj.userIds.length < 1 || obj.userIds.length > MAX_PLAN_USERS) {
    throw new BadRequestException(`Plan must include 1–${MAX_PLAN_USERS} user IDs`);
  }
  const ids = obj.userIds.map(readUserId);
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException('User IDs must be unique');
  }
  return ids;
}

function readSingle(raw: unknown, confirm: boolean): string {
  const obj = objectOnly(raw, confirm ? ['userId', 'confirmation'] : ['userId']);
  const userId = readUserId(obj.userId);
  if (confirm && obj.confirmation !== `CREATE_TESTNET_ACCOUNT_FOR_${userId}`) {
    throw new BadRequestException('Explicit per-user Testnet confirmation is required');
  }
  return userId;
}

function statusOf(row: {
  wallet: { hederaAccountId: string; evmAddress: string } | null;
  walletProvisioning: { state: string } | null;
}): PublicWallet {
  if (row.wallet) {
    return { status: 'READY', hederaAccountId: row.wallet.hederaAccountId, evmAddress: row.wallet.evmAddress };
  }
  if (!row.walletProvisioning) return { status: 'NOT_PROVISIONED' };
  const status: WalletPublicStatus = row.walletProvisioning.state === 'NEEDS_RECONCILIATION'
    ? 'NEEDS_RECONCILIATION'
    : 'PROVISIONING';
  return { status };
}

@Injectable()
export class SimulationWalletOnboardingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** Read-only preflight: never creates an account or uses the Hedera operator. */
  async plan(raw: unknown): Promise<SimulationWalletPlan> {
    const ids = readPlan(raw);
    const rows = await this.prisma.client.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        accountOrigin: true,
        wallet: { select: { hederaAccountId: true, evmAddress: true } },
        walletProvisioning: { select: { state: true } },
      },
    });
    const found = new Map(rows.map((row) => [row.id, row]));
    const users: SimulationWalletStatus[] = ids.map((userId) => {
      const row = found.get(userId);
      if (!row) throw new NotFoundException('A requested household was not found');
      if (row.accountOrigin !== 'SIMULATED') {
        throw new ForbiddenException('Only SIMULATED households may use this onboarding workflow');
      }
      return { userId, ...statusOf(row) };
    });
    return {
      total: users.length,
      ready: users.filter((user) => user.status === 'READY').length,
      notProvisioned: users.filter((user) => user.status === 'NOT_PROVISIONED').length,
      pending: users.filter((user) => user.status === 'PROVISIONING' || user.status === 'NEEDS_RECONCILIATION').length,
      users,
    };
  }

  private ensureHederaReady(): void {
    if (this.config.get<string>('HEDERA_NETWORK') !== 'testnet' ||
        this.config.get<string>('WALLET_PROVISIONING_ENABLED') !== 'true') {
      throw new ForbiddenException('Hedera Testnet wallet operations are disabled');
    }
  }

  private async ensureSimulated(userId: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { accountOrigin: true },
    });
    if (!user) throw new NotFoundException('Household was not found');
    if (user.accountOrigin !== 'SIMULATED') {
      throw new ForbiddenException('Cannot onboard a REGISTERED account through simulation administration');
    }
  }

  /** Exactly ONE explicitly confirmed account creation per HTTP request. */
  async provision(raw: unknown): Promise<SimulationWalletStatus> {
    const userId = readSingle(raw, true);
    this.ensureHederaReady();
    if (this.config.get<string>('SIMULATION_WALLET_ONBOARDING_ENABLED') !== 'true') {
      throw new ForbiddenException('Simulation wallet creation is disabled');
    }
    await this.ensureSimulated(userId);
    const current = await this.wallets.getPublicWallet(userId);
    if (current.status === 'READY') return { userId, ...current };
    if (current.status !== 'NOT_PROVISIONED') {
      throw new ConflictException('Creation is already pending; reconcile the saved transaction, never resubmit');
    }
    // B07 persists an encrypted key and transaction ID BEFORE broadcasting,
    // and uniqueness constraints prevent two simultaneous attempts for one user.
    return { userId, ...(await this.wallets.provision(userId)) };
  }

  /** Recovery is allowed even when NEW simulation-account creation is disabled. */
  async reconcile(raw: unknown): Promise<SimulationWalletStatus> {
    const userId = readSingle(raw, false);
    this.ensureHederaReady();
    await this.ensureSimulated(userId);
    // B07 queries the recorded transaction/alias; it never broadcasts again.
    return { userId, ...(await this.wallets.reconcile(userId)) };
  }
}
