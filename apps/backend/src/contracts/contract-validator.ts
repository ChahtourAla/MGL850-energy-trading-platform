import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

import { Injectable } from '@nestjs/common';

import type {
  ContractKind,
  ContractTypes,
  DeliveryRecord,
  EnergySnapshot,
  HourlyEnergyRecord,
  MatchResult,
  MatchingConfig,
  MatchingInput,
  MatchingOutput,
  UserRegistry,
} from './types.js';

/** Source-of-truth schemas are read directly, not duplicated in the backend. */
const SCHEMA_DIRECTORY = fileURLToPath(
  new URL('../../../../packages/shared/schemas/', import.meta.url),
);

const SCHEMA_BASE = 'https://energy-trading.example/schemas/';

const SCHEMA_FILES = [
  'common.schema.json',
  'user.schema.json',
  'user-registry.schema.json',
  'hourly-energy-record.schema.json',
  'energy-snapshot.schema.json',
  'matching-config.schema.json',
  'matching-input.schema.json',
  'match-result.schema.json',
  'matching-output.schema.json',
  'delivery-record.schema.json',
] as const;

const addFormats = addFormatsModule.default;

export class ContractValidationError extends Error {
  constructor(
    public readonly kind: ContractKind,
    description: string,
  ) {
    super(`${kind}: ${description}`);
    this.name = 'ContractValidationError';
  }
}

function requireInvariant(kind: ContractKind, condition: boolean, reason: string): void {
  if (!condition) {
    throw new ContractValidationError(kind, reason);
  }
}

/** JSON.parse uses IEEE-754 numbers. Reject integers that cannot be stored exactly. */
function requireSafeJsonIntegers(kind: ContractKind, value: unknown, location = '$'): void {
  if (typeof value === 'number' && Number.isInteger(value)) {
    requireInvariant(kind, Number.isSafeInteger(value), `${location} is not a safe JSON integer`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index: number) => {
      requireSafeJsonIntegers(kind, item, `${location}[${index}]`);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      requireSafeJsonIntegers(kind, item, `${location}.${key}`);
    }
  }
}

function checkRecord(kind: ContractKind, record: HourlyEnergyRecord): void {
  const net = record.productionWh - record.consumptionWh;
  requireInvariant(kind, Number.isSafeInteger(net), `unsafe net energy for ${record.userId}`);
  requireInvariant(kind, record.netEnergyWh === net, `netEnergyWh mismatch for ${record.userId}`);
  requireInvariant(
    kind,
    record.availableEnergyWh === Math.max(net, 0),
    `availableEnergyWh mismatch for ${record.userId}`,
  );
  requireInvariant(
    kind,
    record.requiredEnergyWh === Math.max(-net, 0),
    `requiredEnergyWh mismatch for ${record.userId}`,
  );
  const role = net > 0 ? 'SELLER' : net < 0 ? 'BUYER' : 'NEUTRAL';
  requireInvariant(kind, record.marketRole === role, `marketRole mismatch for ${record.userId}`);
}

function checkUsers(kind: ContractKind, users: HourlyEnergyRecord[], timeSlot: string): void {
  const userIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const record of users) {
    checkRecord(kind, record);
    requireInvariant(kind, record.timeSlot === timeSlot, `timeSlot mismatch for ${record.userId}`);
    requireInvariant(kind, !userIds.has(record.userId), `duplicate userId ${record.userId}`);
    requireInvariant(
      kind,
      !recordIds.has(record.recordId),
      `duplicate recordId ${record.recordId}`,
    );
    userIds.add(record.userId);
    recordIds.add(record.recordId);
  }
}

function checkWeights(kind: ContractKind, config: MatchingConfig): void {
  const weights = config.scoringWeights;
  const total = weights.quantity + weights.price + weights.distance + weights.reputation;
  requireInvariant(kind, Math.abs(total - 1) <= 1e-9, 'scoringWeights must sum to 1.0');
}

/** Exact V1 accounting: Wh * micro-USD/kWh, floored at 1000 Wh/kWh. */
export function calculateTotalMicrousd(quantityWh: number, priceMicrousdPerKwh: number): bigint {
  if (
    !Number.isSafeInteger(quantityWh) ||
    quantityWh <= 0 ||
    !Number.isSafeInteger(priceMicrousdPerKwh) ||
    priceMicrousdPerKwh <= 0
  ) {
    throw new RangeError('quantityWh and priceMicrousdPerKwh must be positive safe integers');
  }
  return (BigInt(quantityWh) * BigInt(priceMicrousdPerKwh)) / 1000n;
}

function checkMatch(kind: ContractKind, match: MatchResult): void {
  requireInvariant(
    kind,
    match.buyerId !== match.sellerId,
    'buyer and seller cannot be the same user',
  );
  requireInvariant(
    kind,
    BigInt(match.totalAmountMicrousd) ===
      calculateTotalMicrousd(match.quantityWh, match.unitPriceMicrousdPerKwh),
    `totalAmountMicrousd mismatch for match ${match.matchId}`,
  );
}

function checkOutput(kind: ContractKind, output: MatchingOutput): void {
  const matchIds = new Set<string>();
  const matchedBuyers = new Set<string>();
  for (const match of output.matches) {
    checkMatch(kind, match);
    requireInvariant(
      kind,
      match.timeSlot === output.timeSlot,
      `match timeSlot differs from output: ${match.matchId}`,
    );
    requireInvariant(
      kind,
      match.algorithmVersion === output.algorithmVersion,
      `match algorithmVersion differs from output: ${match.matchId}`,
    );
    requireInvariant(kind, !matchIds.has(match.matchId), `duplicate matchId ${match.matchId}`);
    requireInvariant(
      kind,
      !matchedBuyers.has(match.buyerId),
      `buyer matched more than once: ${match.buyerId}`,
    );
    matchIds.add(match.matchId);
    matchedBuyers.add(match.buyerId);
  }
  for (const userId of output.unmatchedBuyerIds) {
    requireInvariant(
      kind,
      !matchedBuyers.has(userId),
      `buyer both matched and unmatched: ${userId}`,
    );
  }
}

function checkDelivery(kind: ContractKind, delivery: DeliveryRecord): void {
  requireInvariant(
    kind,
    delivery.buyerId !== delivery.sellerId,
    'buyer and seller cannot be the same user',
  );
  if (delivery.status === 'PENDING') {
    requireInvariant(kind, delivery.deliveredWh === 0, 'PENDING delivery must have deliveredWh=0');
  }
  if (delivery.status === 'INCOMPLETE') {
    requireInvariant(
      kind,
      delivery.deliveredWh < delivery.expectedWh,
      'INCOMPLETE delivery must be below expectedWh',
    );
  }
  if (delivery.status === 'SUCCESS' || delivery.status === 'CONFIRMED') {
    requireInvariant(
      kind,
      delivery.deliveredWh >= delivery.expectedWh,
      `${delivery.status} delivery must meet expectedWh`,
    );
  }
}

function checkRegistry(kind: ContractKind, registry: UserRegistry): void {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const user of registry.users) {
    const email = user.email.toLowerCase();
    requireInvariant(kind, !ids.has(user.userId), `duplicate userId ${user.userId}`);
    requireInvariant(kind, !emails.has(email), `duplicate email ${email}`);
    ids.add(user.userId);
    emails.add(email);
  }
}

/** Schema checks run first. These additional rules mirror Python's Pydantic invariants. */
function checkSemantics<K extends ContractKind>(kind: K, value: ContractTypes[K]): void {
  switch (kind) {
    case 'user-registry':
      checkRegistry(kind, value as UserRegistry);
      break;
    case 'hourly-energy-record':
      checkRecord(kind, value as HourlyEnergyRecord);
      break;
    case 'energy-snapshot': {
      const snapshot = value as EnergySnapshot;
      checkUsers(kind, snapshot.users, snapshot.timeSlot);
      break;
    }
    case 'matching-config':
      checkWeights(kind, value as MatchingConfig);
      break;
    case 'matching-input': {
      const input = value as MatchingInput;
      checkWeights(kind, input);
      checkUsers(kind, input.users, input.timeSlot);
      break;
    }
    case 'match-result':
      checkMatch(kind, value as MatchResult);
      break;
    case 'matching-output':
      checkOutput(kind, value as MatchingOutput);
      break;
    case 'delivery-record':
      checkDelivery(kind, value as DeliveryRecord);
      break;
  }
}

/** Reuse this validator in import endpoints, CLI adapters, and tests. */
@Injectable()
export class ContractValidator {
  private readonly validators = new Map<ContractKind, ValidateFunction>();

  constructor() {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    addFormats(ajv);

    for (const filename of SCHEMA_FILES) {
      const contents = readFileSync(join(SCHEMA_DIRECTORY, filename), 'utf8');
      ajv.addSchema(JSON.parse(contents) as object);
    }

    const names: ContractKind[] = [
      'user',
      'user-registry',
      'hourly-energy-record',
      'energy-snapshot',
      'matching-config',
      'matching-input',
      'match-result',
      'matching-output',
      'delivery-record',
    ];
    for (const name of names) {
      const validator = ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`);
      if (!validator) throw new Error(`Shared JSON Schema missing: ${name}`);
      this.validators.set(name, validator);
    }
  }

  parse<K extends ContractKind>(kind: K, value: unknown): ContractTypes[K] {
    const validator = this.validators.get(kind);
    if (!validator) throw new Error(`Unsupported contract kind: ${kind}`);
    if (!validator(value)) {
      const messages = (validator.errors ?? [])
        .slice(0, 4)
        .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
        .join('; ');
      throw new ContractValidationError(kind, messages || 'schema validation failed');
    }
    requireSafeJsonIntegers(kind, value);
    const parsed = value as ContractTypes[K];
    checkSemantics(kind, parsed);
    return parsed;
  }

  async readFile<K extends ContractKind>(
    kind: K,
    path: string,
    maxBytes = 20 * 1024 * 1024,
  ): Promise<ContractTypes[K]> {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) {
      throw new ContractValidationError(kind, 'not a regular JSON file or file too large');
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      throw new ContractValidationError(kind, 'invalid JSON syntax');
    }
    return this.parse(kind, value);
  }
}

/** Validate an output against its ORIGINAL input before persisting any matches. */
export function assertMatchingOutputAgainstInput(
  validator: ContractValidator,
  outputValue: unknown,
  inputValue: unknown,
): MatchingOutput {
  const kind: ContractKind = 'matching-output';
  const input = validator.parse('matching-input', inputValue);
  const output = validator.parse('matching-output', outputValue);

  requireInvariant(
    kind,
    output.schemaVersion === input.schemaVersion,
    'schemaVersion differs from input',
  );
  requireInvariant(kind, output.snapshotId === input.snapshotId, 'snapshotId differs from input');
  requireInvariant(kind, output.timeSlot === input.timeSlot, 'timeSlot differs from input');
  requireInvariant(
    kind,
    output.algorithmVersion === input.algorithmVersion,
    'algorithmVersion differs from input',
  );

  const buyers = new Map(
    input.users.filter((u) => u.marketRole === 'BUYER').map((u) => [u.userId, u]),
  );
  const sellers = new Map(
    input.users.filter((u) => u.marketRole === 'SELLER').map((u) => [u.userId, u]),
  );
  const remaining = new Map([...sellers].map(([id, user]) => [id, BigInt(user.availableEnergyWh)]));
  const matched = new Set<string>();

  for (const match of output.matches) {
    const buyer = buyers.get(match.buyerId);
    const seller = sellers.get(match.sellerId);
    requireInvariant(kind, Boolean(buyer), `unknown or non-BUYER buyerId ${match.buyerId}`);
    requireInvariant(kind, Boolean(seller), `unknown or non-SELLER sellerId ${match.sellerId}`);
    if (!buyer || !seller) continue;

    requireInvariant(
      kind,
      match.buyerWallet.toLowerCase() === buyer.evmAddress.toLowerCase(),
      'buyer wallet mismatch',
    );
    requireInvariant(
      kind,
      match.sellerWallet.toLowerCase() === seller.evmAddress.toLowerCase(),
      'seller wallet mismatch',
    );
    requireInvariant(
      kind,
      match.sellerEnergyType === seller.energyType,
      'seller energy type mismatch',
    );
    requireInvariant(
      kind,
      match.quantityWh === buyer.requiredEnergyWh,
      'buyer must be fully matched',
    );
    requireInvariant(
      kind,
      match.unitPriceMicrousdPerKwh === seller.askPriceMicrousdPerKwh,
      'seller ask price mismatch',
    );
    requireInvariant(
      kind,
      match.unitPriceMicrousdPerKwh <= (buyer.maxPriceMicrousdPerKwh ?? 0),
      'buyer max price exceeded',
    );
    const distance = Math.hypot(seller.xKm - buyer.xKm, seller.yKm - buyer.yKm);
    requireInvariant(
      kind,
      Math.abs(match.distanceKm - distance) <= 1e-9,
      'distance differs from original coordinates',
    );
    requireInvariant(
      kind,
      match.distanceKm <= input.maximumDistanceKm + 1e-9,
      'maximum distance exceeded',
    );

    const remainingWh = (remaining.get(seller.userId) ?? 0n) - BigInt(match.quantityWh);
    requireInvariant(kind, remainingWh >= 0n, `seller oversold: ${seller.userId}`);
    remaining.set(seller.userId, remainingWh);
    matched.add(buyer.userId);
  }

  const expectedUnmatched = [...buyers.keys()].filter((id) => !matched.has(id));
  requireInvariant(
    kind,
    expectedUnmatched.length === output.unmatchedBuyerIds.length,
    'unmatched buyer count mismatch',
  );
  const actualUnmatched = new Set(output.unmatchedBuyerIds);
  requireInvariant(
    kind,
    expectedUnmatched.every((id) => actualUnmatched.has(id)),
    'unmatched buyer IDs inconsistent',
  );
  return output;
}
