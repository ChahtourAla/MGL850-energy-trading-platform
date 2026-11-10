/** B14 phase A: pure deterministic trade planning, no network, keys, DB mutations or writes. */
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CHAIN_ID = 296;

export function requireUuid(value, name = 'UUID') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name} is not a valid UUID`);
  return value.toLowerCase();
}

export function requireUint(value, label, { positive = false } = {}) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || text.length > 78) throw new Error(`${label} must be an unsigned decimal integer`);
  const n = BigInt(text);
  if (n > UINT256_MAX || (positive && n === 0n)) throw new Error(`${label} is out of range`);
  return n;
}

export function requireAddress(address, label = 'EVM address') {
  if (typeof address !== 'string' || !ADDRESS.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`${label} must be a nonzero EVM address`);
  }
  return address;
}

function strictUtc(input, pattern, label) {
  if (typeof input !== 'string' || !pattern.test(input) || !Number.isFinite(Date.parse(input)) ||
      new Date(input).toISOString().replace('.000Z', 'Z') !== input) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
  return new Date(input);
}

export function parseB14Args(argv) {
  const values = {};
  const names = new Set(['--time-slot', '--match-id', '--delivery-start', '--operator-address']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--offline') {
      if (values.offline) throw new Error('Repeated --offline');
      values.offline = true;
      continue;
    }
    if (!names.has(arg) || Object.hasOwn(values, arg) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown, missing or repeated B14 option: ${arg}`);
    }
    values[arg] = argv[++i];
  }
  if (values.offline) {
    if (Object.keys(values).length !== 1) throw new Error('--offline cannot be combined with live options');
    return { offline: true };
  }
  if (!values['--time-slot'] || !values['--delivery-start']) {
    throw new Error('Read-only live preflight requires --time-slot and --delivery-start');
  }
  strictUtc(values['--time-slot'], HOUR, 'time-slot');
  strictUtc(values['--delivery-start'], ISO_SECOND, 'delivery-start');
  if (values['--match-id']) requireUuid(values['--match-id'], 'match-id');
  if (values['--operator-address']) requireAddress(values['--operator-address'], 'operator-address');
  return {
    offline: false,
    timeSlot: values['--time-slot'],
    matchId: values['--match-id']?.toLowerCase(),
    deliveryStart: values['--delivery-start'],
    operatorAddress: values['--operator-address'],
  };
}

/** A unique, stable trade intent scoped to this chain and deployed escrow. */
export function externalTradeId(matchId, escrowAddress) {
  const id = requireUuid(matchId, 'matchId');
  const escrow = requireAddress(escrowAddress, 'escrowAddress');
  return `0x${createHash('sha256').update(`mgl850:b14:v1:${CHAIN_ID}:${escrow.toLowerCase()}:${id}`).digest('hex')}`;
}

export function computePayment(quantityWh, unitPriceMicrousdPerKwh) {
  const quantity = requireUint(quantityWh, 'quantityWh', { positive: true });
  const price = requireUint(unitPriceMicrousdPerKwh, 'unitPriceMicrousdPerKwh', { positive: true });
  if (quantity > UINT256_MAX / price) throw new Error('Payment multiplication would overflow uint256');
  const total = quantity * price / 1000n;
  if (total === 0n) throw new Error('Computed token payment cannot round to zero');
  return total;
}

export function chooseMatch(matches, matchId) {
  if (!Array.isArray(matches)) throw new Error('Stored matches must be an array');
  if (matches.length === 0) throw new Error('No B12 matches were committed for that hour');
  if (matches.some(m => !m?.id)) throw new Error('Malformed match row');
  const result = matchId ? matches.find(m => m.id.toLowerCase() === matchId.toLowerCase()) :
    matches.length === 1 ? matches[0] : null;
  if (!result) throw new Error('Specify --match-id to select exactly one stored match');
  if (result.status !== 'SELECTED') throw new Error(`Match status ${result.status} is not eligible for B14`);
  return result;
}

export function assertStoredMatch({ match, run, rows, energyRecords, buyerWallet, sellerWallet, buyerProfile }) {
  if (!run || !Array.isArray(rows) || !Array.isArray(energyRecords)) throw new Error('Missing trusted B12 matching run/energy records');
  if (rows.length !== run.matchCount || rows.some(m => !['SELECTED', 'TRADE_CREATED'].includes(m.status))) {
    throw new Error('Matching run counts or statuses differ; do not create trades from modified results');
  }
  if (!run.snapshotId || match.timeSlot?.getTime() !== run.timeSlot?.getTime()) {
    throw new Error('Selected match differs from matching run hour');
  }
  const seenIds = new Set(), seenBuyer = new Set();
  const allocations = new Map();
  for (const m of rows) {
    requireUuid(m.id, 'stored match ID');
    if (seenIds.has(m.id) || seenBuyer.has(m.buyerId)) throw new Error('Duplicate match or buyer allocation');
    if (m.timeSlot?.getTime() !== run.timeSlot?.getTime()) throw new Error('Match outside selected hour');
    seenIds.add(m.id); seenBuyer.add(m.buyerId);
    const quantity = requireUint(m.quantityWh, 'match quantity', { positive: true });
    allocations.set(m.sellerId, (allocations.get(m.sellerId) ?? 0n) + quantity);
  }
  const byUser = new Map(energyRecords.map(e => [e.userId, e]));
  if (byUser.size !== energyRecords.length) throw new Error('Duplicate energy rows');
  for (const [sellerId, allocated] of allocations) {
    const seller = byUser.get(sellerId);
    if (!seller || seller.marketRole !== 'SELLER' || seller.snapshotId !== run.snapshotId ||
        allocated > requireUint(seller.availableEnergyWh, 'seller availableEnergyWh')) {
      throw new Error('Seller allocation exceeds trusted energy inventory');
    }
  }
  const buyerEnergy = byUser.get(match.buyerId), sellerEnergy = byUser.get(match.sellerId);
  if (!buyerEnergy || !sellerEnergy || buyerEnergy.marketRole !== 'BUYER' ||
      sellerEnergy.marketRole !== 'SELLER' ||
      buyerEnergy.timeSlot?.getTime() !== run.timeSlot?.getTime() ||
      sellerEnergy.timeSlot?.getTime() !== run.timeSlot?.getTime() || match.buyerId === match.sellerId ||
      buyerEnergy.snapshotId !== run.snapshotId || sellerEnergy.snapshotId !== run.snapshotId) {
    throw new Error('Buyer/seller energy provenance does not match B12');
  }
  const quantity = requireUint(match.quantityWh, 'quantity', {positive:true});
  const unitPrice = requireUint(match.unitPriceMicrousdPerKwh, 'unitPrice', {positive:true});
  if (quantity !== requireUint(buyerEnergy.requiredEnergyWh, 'buyer need', {positive:true}) ||
      unitPrice !== requireUint(sellerEnergy.askPriceMicrousdPerKwh, 'seller ask', {positive:true}) ||
      unitPrice > requireUint(buyerEnergy.maxPriceMicrousdPerKwh, 'buyer max', {positive:true})) {
    throw new Error('Match terms no longer agree with the B11 energy source');
  }
  if (!buyerProfile || (buyerProfile.preferredEnergyType !== 'ANY' &&
      buyerProfile.preferredEnergyType !== sellerEnergy.energyType)) {
    throw new Error('Buyer preferred energy type does not match seller energy type');
  }
  if (!buyerWallet || !sellerWallet || buyerWallet.userId !== match.buyerId || sellerWallet.userId !== match.sellerId) {
    throw new Error('Missing or mislinked B07 verified custodial wallets');
  }
  requireAddress(buyerWallet.evmAddress, 'buyer wallet');
  requireAddress(sellerWallet.evmAddress, 'seller wallet');
  if (buyerWallet.evmAddress.toLowerCase() === sellerWallet.evmAddress.toLowerCase()) {
    throw new Error('Cannot trade with self');
  }
  const total = computePayment(quantity, unitPrice);
  if (total !== requireUint(match.totalAmountMicrousd, 'match total', {positive:true})) {
    throw new Error('Stored payment total does not equal Solidity integer calculation');
  }
  return { buyer: buyerWallet.evmAddress, seller: sellerWallet.evmAddress,
    quantityWh: quantity.toString(), unitPriceMicrousdPerKwh: unitPrice.toString(), totalAmountMicrousd: total.toString() };
}

export function tradeWindow(deliveryStart, now = new Date()) {
  const start = strictUtc(deliveryStart, ISO_SECOND, 'delivery-start');
  if (start.getTime() < now.getTime() + 10 * 60 * 1000) {
    throw new Error('Delivery start must be at least 10 minutes in the future');
  }
  if (start.getTime() > now.getTime() + 30 * 24 * 3600_000) {
    throw new Error('Prototype delivery start cannot exceed 30 days from now');
  }
  const deadline = new Date(start.getTime() + 3600_000);
  return { deliveryStart: String(Math.floor(start.getTime() / 1000)),
    deliveryDeadline: String(Math.floor(deadline.getTime() / 1000)),
    startUtc: start.toISOString(), deadlineUtc: deadline.toISOString() };
}

export function assertExistingChainMatches(trade, expected, id) {
  if (trade.externalTradeId.toLowerCase() !== id.toLowerCase() ||
      trade.buyer.toLowerCase() !== expected.buyer.toLowerCase() ||
      trade.seller.toLowerCase() !== expected.seller.toLowerCase() ||
      trade.quantityWh !== expected.quantityWh ||
      trade.unitPriceMicrousdPerKwh !== expected.unitPriceMicrousdPerKwh ||
      trade.totalAmountMicrousd !== expected.totalAmountMicrousd) {
    throw new Error('Existing on-chain trade differs from selected B12 match; STOP');
  }
}
