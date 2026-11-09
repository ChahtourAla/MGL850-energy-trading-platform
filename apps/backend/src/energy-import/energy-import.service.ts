import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ContractValidationError, ContractValidator } from '../contracts/contract-validator.js';
import { toEnergyRecordData } from '../contracts/contract-mappers.js';
import type { EnergySnapshot } from '../contracts/types.js';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_RECORDS = 200;

type EnergyData = ReturnType<typeof toEnergyRecordData>;

type PersistedEnergy = Omit<
  EnergyData,
  'marketRole' | 'energyType' | 'availableEnergyWh' | 'requiredEnergyWh'
> & {
  snapshotId: string | null;
  marketRole: string;
  energyType: string | null;
  availableEnergyWh: bigint | null;
  requiredEnergyWh: bigint | null;
};

export interface EnergyImportResult {
  source: 'energy-snapshot';
  snapshotId: string;
  timeSlot: string;
  total: number;
  created: number;
  unchanged: number;
}

/** Stable serialization independent of object-key order in JSON input. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function snapshotDigest(snapshot: EnergySnapshot): string {
  // User order has no semantic meaning; normalize it before fingerprinting.
  const normalized = {
    ...snapshot,
    users: [...snapshot.users].sort((a, b) =>
      a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
    ),
  };
  return createHash('sha256').update(stableJson(normalized), 'utf8').digest('hex');
}

function sameEnergy(stored: PersistedEnergy, wanted: EnergyData, snapshotId: string): boolean {
  return (
    stored.id === wanted.id &&
    stored.snapshotId === snapshotId &&
    stored.userId === wanted.userId &&
    new Date(stored.timeSlot).getTime() === wanted.timeSlot.getTime() &&
    stored.productionWh === wanted.productionWh &&
    stored.consumptionWh === wanted.consumptionWh &&
    stored.netEnergyWh === wanted.netEnergyWh &&
    stored.marketRole === wanted.marketRole &&
    stored.availableEnergyWh === wanted.availableEnergyWh &&
    stored.requiredEnergyWh === wanted.requiredEnergyWh &&
    stored.energyType === wanted.energyType &&
    stored.askPriceMicrousdPerKwh === wanted.askPriceMicrousdPerKwh &&
    stored.maxPriceMicrousdPerKwh === wanted.maxPriceMicrousdPerKwh
  );
}

@Injectable()
export class EnergyImportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContractValidator) private readonly contracts: ContractValidator,
  ) {}

  async importSnapshot(raw: unknown): Promise<EnergyImportResult> {
    let snapshot: EnergySnapshot;
    try {
      snapshot = this.contracts.parse('energy-snapshot', raw);
    } catch (error: unknown) {
      if (error instanceof ContractValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    if (snapshot.users.length > MAX_RECORDS) {
      throw new BadRequestException(`Maximum ${MAX_RECORDS} hourly records per import`);
    }

    const timeSlot = new Date(snapshot.timeSlot);
    const digest = snapshotDigest(snapshot);
    const data = snapshot.users.map(toEnergyRecordData);
    const ids = snapshot.users.map((record) => record.userId);

    try {
      return await this.prisma.client.$transaction(
        async (tx): Promise<EnergyImportResult> => {
          const matches = await tx.energySnapshotImport.findMany({
            where: { OR: [{ id: snapshot.snapshotId }, { timeSlot }] },
          });
          if (matches.length > 0) {
            const saved = matches.length === 1 ? matches[0] : null;
            if (
              !saved ||
              saved.id !== snapshot.snapshotId ||
              saved.timeSlot.getTime() !== timeSlot.getTime() ||
              saved.payloadSha256 !== digest ||
              saved.recordCount !== snapshot.users.length ||
              saved.schemaVersion !== snapshot.schemaVersion ||
              saved.generatorVersion !== snapshot.generatorVersion
            ) {
              throw new ConflictException(
                'A different snapshot already occupies this ID or UTC hour',
              );
            }

            // Do not report success if metadata remains but the associated data was altered.
            const persisted = await tx.energyRecord.findMany({ where: { timeSlot } });
            const byId = new Map(persisted.map((record) => [record.id, record]));
            if (
              persisted.length !== data.length ||
              data.some((record) => {
                const row = byId.get(record.id);
                return !row || !sameEnergy(row, record, snapshot.snapshotId);
              })
            ) {
              throw new ConflictException(
                'Existing hourly records do not match the original snapshot',
              );
            }
            return {
              source: 'energy-snapshot',
              snapshotId: snapshot.snapshotId,
              timeSlot: snapshot.timeSlot,
              total: data.length,
              created: 0,
              unchanged: data.length,
            };
          }

          // Legacy or separately imported records at this hour must never be overwritten.
          if ((await tx.energyRecord.count({ where: { timeSlot } })) !== 0) {
            throw new ConflictException('Energy records already exist for this UTC hour');
          }

          const users = await tx.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, wallet: { select: { evmAddress: true } } },
          });
          const byUser = new Map(users.map((user) => [user.id, user]));
          for (const record of snapshot.users) {
            const user = byUser.get(record.userId);
            if (!user) {
              throw new ConflictException('Snapshot references a user not present in the registry');
            }
            // The snapshot's EVM address is a claim, not proof of wallet ownership.
            // Only B07's persisted wallet is authoritative.
            if (!user.wallet) {
              throw new ConflictException('Snapshot user has no verified Hedera wallet');
            }
            if (user.wallet.evmAddress.toLowerCase() !== record.evmAddress.toLowerCase()) {
              throw new ConflictException(
                'Snapshot wallet address disagrees with the verified wallet',
              );
            }
          }

          await tx.energySnapshotImport.create({
            data: {
              id: snapshot.snapshotId,
              timeSlot,
              schemaVersion: snapshot.schemaVersion,
              generatorVersion: snapshot.generatorVersion,
              payloadSha256: digest,
              recordCount: data.length,
            },
          });
          await tx.energyRecord.createMany({
            data: data.map((record) => ({ ...record, snapshotId: snapshot.snapshotId })),
          });
          return {
            source: 'energy-snapshot',
            snapshotId: snapshot.snapshotId,
            timeSlot: snapshot.timeSlot,
            total: data.length,
            created: data.length,
            unchanged: 0,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15_000,
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2034')
      ) {
        throw new ConflictException(
          'Concurrent or conflicting snapshot import; review the saved hour',
        );
      }
      throw error;
    }
  }
}
