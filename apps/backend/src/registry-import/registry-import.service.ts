import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ContractValidationError, ContractValidator } from '../contracts/contract-validator.js';
import { toUserProfileFields } from '../contracts/contract-mappers.js';
import type { UserProfile, UserRegistry } from '../contracts/types.js';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_USERS_PER_REQUEST = 200;
const DISABLED_PASSWORD_HASH = '!SIMULATED_ACCOUNT_NO_LOGIN!';

export interface ImportResult {
  source: 'user-registry';
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  preservedRegistered: number;
}

interface PreparedUser {
  id: string;
  name: string;
  email: string;
  physicalAddress: string;
  xKm: string;
  yKm: string;
  reputation: number;
  preferredEnergyType: string;
}

function prepareUser(user: UserProfile): PreparedUser {
  // The shared schema is canonical; these additional limits match the
  // PostgreSQL column sizes and the B06 registration constraints.
  const name = user.name.trim();
  const email = user.email.trim().normalize('NFC').toLowerCase();
  const physicalAddress = user.physicalAddress.trim();
  if (!name || name.length > 255 || email.length > 320 || !physicalAddress ||
      Math.abs(user.xKm) > 1_000_000 || Math.abs(user.yKm) > 1_000_000) {
    throw new BadRequestException('Registry profile exceeds allowed field limits');
  }
  if (user.hederaAccountId !== undefined || user.evmAddress !== undefined) {
    // A JSON import must never forge or replace the custody records created by B07.
    // Wallet-enriched exports are a separate read-only integration path.
    throw new BadRequestException('Wallet identifiers cannot be imported; use the WalletsModule');
  }
  return {
    ...toUserProfileFields(user),
    name,
    email,
    physicalAddress,
  };
}

@Injectable()
export class RegistryImportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContractValidator) private readonly contracts: ContractValidator,
  ) {}

  async importRegistry(raw: unknown): Promise<ImportResult> {
    let registry: UserRegistry;
    try {
      registry = this.contracts.parse('user-registry', raw);
    } catch (error: unknown) {
      if (error instanceof ContractValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    if (registry.users.length > MAX_USERS_PER_REQUEST) {
      throw new BadRequestException(`Maximum ${MAX_USERS_PER_REQUEST} users per import`);
    }

    // Preflight is entirely in memory; no partial database writes for bad JSON.
    const users = registry.users.map(prepareUser);
    const emails = new Set<string>();
    for (const user of users) {
      if (emails.has(user.email)) {
        throw new BadRequestException('Duplicate normalized email in registry');
      }
      emails.add(user.email);
    }

    try {
      return await this.prisma.client.$transaction(async (tx): Promise<ImportResult> => {
        const existing = await tx.user.findMany({
          where: {
            OR: [
              { id: { in: users.map((u) => u.id) } },
              { email: { in: users.map((u) => u.email), mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            email: true,
            accountOrigin: true,
            name: true,
            physicalAddress: true,
            xKm: true,
            yKm: true,
            reputation: true,
            preferredEnergyType: true,
          },
        });
        const byId = new Map(existing.map((row) => [row.id, row]));
        const byEmail = new Map(existing.map((row) => [row.email.toLowerCase(), row]));

        // Detect EVERY identity collision before the first write.
        for (const user of users) {
          const sameId = byId.get(user.id);
          const sameEmail = byEmail.get(user.email);
          if ((sameId && sameId.email.toLowerCase() !== user.email) ||
              (sameEmail && sameEmail.id !== user.id)) {
            throw new ConflictException('Registry user ID/email conflicts with an existing account');
          }
        }

        const result: ImportResult = {
          source: 'user-registry',
          total: users.length,
          created: 0,
          updated: 0,
          unchanged: 0,
          preservedRegistered: 0,
        };

        for (const user of users) {
          const current = byId.get(user.id);
          if (!current) {
            await tx.user.create({
              data: {
                ...user,
                accountOrigin: 'SIMULATED',
                passwordHash: DISABLED_PASSWORD_HASH,
              },
            });
            result.created += 1;
            continue;
          }
          if (current.accountOrigin !== 'SIMULATED') {
            // Registered users are authoritative; never overwrite their profile.
            result.preservedRegistered += 1;
            continue;
          }
          const isSame = current.name === user.name &&
            current.physicalAddress === user.physicalAddress &&
            current.xKm?.toString() === new Prisma.Decimal(user.xKm).toString() &&
            current.yKm?.toString() === new Prisma.Decimal(user.yKm).toString() &&
            current.reputation === user.reputation &&
            current.preferredEnergyType === user.preferredEnergyType;

          if (isSame) {
            result.unchanged += 1;
          } else {
            await tx.user.update({
              where: { id: user.id },
              data: {
                name: user.name,
                physicalAddress: user.physicalAddress,
                xKm: user.xKm,
                yKm: user.yKm,
                reputation: user.reputation,
                preferredEnergyType: user.preferredEnergyType,
              },
            });
            result.updated += 1;
          }
        }
        return result;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034')) {
        throw new ConflictException('Concurrent registry import conflict; retry the request');
      }
      throw error;
    }
  }
}
