import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HederaWalletGateway } from './hedera-wallet.gateway.js';
import { WalletCryptoService } from './wallet-crypto.service.js';
import type { PublicWallet } from './wallet.types.js';

@Injectable()
export class WalletsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HederaWalletGateway) private readonly gateway: HederaWalletGateway,
    @Inject(WalletCryptoService) private readonly crypto: WalletCryptoService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private ensureProvisioningAllowed(): void {
    if (this.config.get<string>('WALLET_PROVISIONING_ENABLED') !== 'true') {
      throw new ForbiddenException('Testnet wallet provisioning is disabled');
    }
  }

  async getPublicWallet(userId: string): Promise<PublicWallet> {
    const wallet = await this.prisma.client.wallet.findUnique({ where: { userId } });
    if (wallet) {
      return {
        status: 'READY',
        hederaAccountId: wallet.hederaAccountId,
        evmAddress: wallet.evmAddress,
      };
    }
    const attempt = await this.prisma.client.walletProvisioning.findUnique({
      where: { userId },
      select: { state: true },
    });
    if (!attempt) return { status: 'NOT_PROVISIONED' };
    return {
      status: attempt.state === 'NEEDS_RECONCILIATION'
        ? 'NEEDS_RECONCILIATION'
        : 'PROVISIONING',
    };
  }

  async provision(userId: string): Promise<PublicWallet> {
    this.ensureProvisioningAllowed();
    const current = await this.getPublicWallet(userId);
    if (current.status === 'READY') return current;
    if (current.status !== 'NOT_PROVISIONED') {
      throw new ConflictException('Wallet provisioning already started; reconcile before retrying');
    }

    // No network call occurs until the encrypted private key and stable
    // transaction ID are durably written to PostgreSQL.
    const prepared = this.gateway.prepare();
    const sealed = this.crypto.encrypt(userId, prepared.privateKey);
    try {
      await this.prisma.client.walletProvisioning.create({
        data: {
          userId,
          publicKey: prepared.publicKey,
          evmAddress: prepared.evmAddress,
          ...sealed,
          transactionId: prepared.transactionId,
          state: 'PREPARED',
        },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Wallet provisioning already started');
      }
      throw error;
    }

    // Claim an immutable transaction ID before broadcast. In case of crash,
    // follow-up calls must RECONCILE this attempt, never create another one.
    await this.prisma.client.walletProvisioning.update({
      where: { userId }, data: { state: 'SUBMITTED' },
    });

    try {
      const result = await this.gateway.submit({
        publicKey: prepared.publicKey,
        transactionId: prepared.transactionId,
      });
      return await this.finalize(userId, result.hederaAccountId);
    } catch {
      try {
        await this.prisma.client.walletProvisioning.update({
          where: { userId }, data: { state: 'NEEDS_RECONCILIATION' },
        });
      } catch {
        // PostgreSQL may be unavailable; the PREPARED/SUBMITTED row has
        // already committed the transaction ID needed for recovery.
      }
      throw new ServiceUnavailableException(
        'Wallet creation could not be confirmed; use reconciliation, not another creation',
      );
    }
  }

  async reconcile(userId: string): Promise<PublicWallet> {
    this.ensureProvisioningAllowed();
    const existing = await this.getPublicWallet(userId);
    if (existing.status === 'READY' || existing.status === 'NOT_PROVISIONED') return existing;
    const attempt = await this.prisma.client.walletProvisioning.findUnique({ where: { userId } });
    if (!attempt) return this.getPublicWallet(userId);

    try {
      // This is a READ of an existing transaction, never a re-broadcast.
      const accountId = await this.gateway.findCreatedAccount(attempt.transactionId, attempt.evmAddress);
      if (accountId) return this.finalize(userId, accountId);
    } catch {
      // Receipt may not be available yet; do not guess that creation failed.
    }
    try {
      await this.prisma.client.walletProvisioning.update({
        where: { userId }, data: { state: 'NEEDS_RECONCILIATION' },
      });
    } catch {
      // Don't fabricate a positive state when database is unreachable.
      throw new ServiceUnavailableException('Wallet reconciliation is temporarily unavailable');
    }
    return { status: 'NEEDS_RECONCILIATION' };
  }

  private async finalize(userId: string, hederaAccountId: string): Promise<PublicWallet> {
    // Both creation of the permanent wallet and deletion of the encrypted
    // staging record happen atomically. A crash cannot leave a half-migrated key.
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (wallet) {
          return {
            status: 'READY' as const,
            hederaAccountId: wallet.hederaAccountId,
            evmAddress: wallet.evmAddress,
          };
        }
        const attempt = await tx.walletProvisioning.findUnique({ where: { userId } });
        if (!attempt) throw new ConflictException('Wallet provisioning record is missing');
        const saved = await tx.wallet.create({
          data: {
            userId,
            hederaAccountId,
            evmAddress: attempt.evmAddress,
            publicKey: attempt.publicKey,
            encryptedPrivateKey: attempt.encryptedPrivateKey,
            encryptionIv: attempt.encryptionIv,
            encryptionAuthTag: attempt.encryptionAuthTag,
            keyVersion: attempt.keyVersion,
          },
        });
        await tx.walletProvisioning.delete({ where: { userId } });
        return {
          status: 'READY' as const,
          hederaAccountId: saved.hederaAccountId,
          evmAddress: saved.evmAddress,
        };
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const ready = await this.getPublicWallet(userId);
        if (ready.status === 'READY') return ready;
      }
      throw error;
    }
  }
}
