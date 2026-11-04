import type { DeliveryRecord, HourlyEnergyRecord, MatchResult, UserProfile } from './types.js';

/**
 * Map VALIDATED external contracts to the column names/types in B04 Prisma.
 * Always call ContractValidator.parse before using these functions.
 * BigInt is intentionally NOT JSON-serializable; keep it inside persistence.
 */
export function toEnergyRecordData(record: HourlyEnergyRecord) {
  return {
    id: record.recordId,
    userId: record.userId,
    timeSlot: new Date(record.timeSlot),
    productionWh: BigInt(record.productionWh),
    consumptionWh: BigInt(record.consumptionWh),
    netEnergyWh: BigInt(record.netEnergyWh),
    marketRole: record.marketRole,
    availableEnergyWh: BigInt(record.availableEnergyWh),
    requiredEnergyWh: BigInt(record.requiredEnergyWh),
    energyType: record.energyType,
    askPriceMicrousdPerKwh: record.askPriceMicrousdPerKwh === null
      ? null : BigInt(record.askPriceMicrousdPerKwh),
    maxPriceMicrousdPerKwh: record.maxPriceMicrousdPerKwh === null
      ? null : BigInt(record.maxPriceMicrousdPerKwh),
  };
}

export function toMatchData(match: MatchResult) {
  return {
    id: match.matchId,
    timeSlot: new Date(match.timeSlot),
    buyerId: match.buyerId,
    sellerId: match.sellerId,
    quantityWh: BigInt(match.quantityWh),
    unitPriceMicrousdPerKwh: BigInt(match.unitPriceMicrousdPerKwh),
    totalAmountMicrousd: BigInt(match.totalAmountMicrousd),
    distanceKm: match.distanceKm.toString(),
    score: match.score.toString(),
    sellerEnergyType: match.sellerEnergyType,
    algorithmVersion: match.algorithmVersion,
    status: 'SELECTED' as const,
  };
}

export function toDeliveryRecordData(record: DeliveryRecord) {
  return {
    id: record.deliveryId,
    tradeId: record.tradeId,
    expectedWh: BigInt(record.expectedWh),
    deliveredWh: BigInt(record.deliveredWh),
    timeSlot: new Date(record.timeSlot),
    status: record.status,
    evidenceHash: record.evidenceHash ?? null,
  };
}

/**
 * A user registry does not contain passwordHash, so this is NOT a complete
 * Prisma User create payload. B06/B08 must supply credentials or a clear
 * separate import identity policy before inserting users.
 */
export function toUserProfileFields(user: UserProfile) {
  return {
    id: user.userId,
    name: user.name,
    email: user.email,
    physicalAddress: user.physicalAddress,
    xKm: user.xKm.toString(),
    yKm: user.yKm.toString(),
    reputation: user.reputation,
    preferredEnergyType: user.preferredEnergyType,
  };
}
