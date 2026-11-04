/** TypeScript representations of external JSON payloads.
 * Runtime authority: packages/shared/schemas/*.schema.json.
 * Do not use these interfaces instead of runtime validation.
 */
export type EnergyType = 'SOLAR' | 'WIND' | 'HYDRO' | 'GRID' | 'MIXED';
export type PreferredEnergyType = EnergyType | 'ANY';
export type MarketRole = 'SELLER' | 'BUYER' | 'NEUTRAL';

export interface UserProfile {
  userId: string;
  name: string;
  email: string;
  physicalAddress: string;
  xKm: number;
  yKm: number;
  preferredEnergyType: PreferredEnergyType;
  reputation: number;
  hederaAccountId?: string;
  evmAddress?: string;
}

export interface UserRegistry {
  schemaVersion: string;
  users: UserProfile[];
}

export interface HourlyEnergyRecord {
  recordId: string;
  userId: string;
  timeSlot: string;
  productionWh: number;
  consumptionWh: number;
  netEnergyWh: number;
  marketRole: MarketRole;
  availableEnergyWh: number;
  requiredEnergyWh: number;
  energyType: EnergyType | null;
  askPriceMicrousdPerKwh: number | null;
  maxPriceMicrousdPerKwh: number | null;
  xKm: number;
  yKm: number;
  reputation: number;
  preferredEnergyType: PreferredEnergyType;
  evmAddress: string;
}

export interface EnergySnapshot {
  schemaVersion: string;
  snapshotId: string;
  timeSlot: string;
  generatorVersion: string;
  users: HourlyEnergyRecord[];
}

export interface ScoringWeights {
  quantity: number;
  price: number;
  distance: number;
  reputation: number;
}

export interface MatchingConfig {
  schemaVersion: string;
  algorithmVersion: string;
  maximumDistanceKm: number;
  scoringWeights: ScoringWeights;
}

export interface MatchingInput extends MatchingConfig {
  snapshotId: string;
  timeSlot: string;
  users: HourlyEnergyRecord[];
}

export interface MatchResult {
  matchId: string;
  algorithmVersion: string;
  timeSlot: string;
  buyerId: string;
  buyerWallet: string;
  sellerId: string;
  sellerWallet: string;
  quantityWh: number;
  unitPriceMicrousdPerKwh: number;
  totalAmountMicrousd: number;
  distanceKm: number;
  score: number;
  sellerEnergyType: EnergyType;
  createdAt: string;
}

export interface MatchingOutput {
  schemaVersion: string;
  snapshotId: string;
  timeSlot: string;
  algorithmVersion: string;
  executionTimeMs: number;
  matches: MatchResult[];
  unmatchedBuyerIds: string[];
  warnings: string[];
}

export type DeliveryStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'INCOMPLETE'
  | 'INVALID'
  | 'CONFIRMED';

export interface DeliveryRecord {
  deliveryId: string;
  tradeId: string;
  onChainTradeId: number;
  sellerId: string;
  buyerId: string;
  expectedWh: number;
  deliveredWh: number;
  timeSlot: string;
  status: DeliveryStatus;
  evidenceHash?: string;
}

export interface ContractTypes {
  'user': UserProfile;
  'user-registry': UserRegistry;
  'hourly-energy-record': HourlyEnergyRecord;
  'energy-snapshot': EnergySnapshot;
  'matching-config': MatchingConfig;
  'matching-input': MatchingInput;
  'match-result': MatchResult;
  'matching-output': MatchingOutput;
  'delivery-record': DeliveryRecord;
}

export type ContractKind = keyof ContractTypes;
