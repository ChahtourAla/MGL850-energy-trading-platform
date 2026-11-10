/**
 * B18: pure, dependency-free trading API policies.
 * No signer, network, file system, DB access or transaction submission.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^0x[0-9a-fA-F]{40}$/;
const POSITIVE = /^[1-9][0-9]*$/;
const PAGE_MAX = 50;
const SUPPORTED_ACTIONS = Object.freeze(['CANCEL', 'EXPIRE', 'REFUND', 'ORACLE_CONFIRM', 'DB_RECONCILE']);

export function assertUuid(value, name='id') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

export function parsePage(limit='20', cursor=undefined) {
  if (limit === undefined) limit = '20';
  if (typeof limit !== 'string' || !POSITIVE.test(limit) || limit.length > 3) {
    throw new Error('limit must be a positive integer (1–50)');
  }
  const n = Number(limit);
  if (n > PAGE_MAX) throw new Error('limit must be between 1 and 50');
  if (cursor !== undefined && (typeof cursor !== 'string' || !UUID.test(cursor))) {
    throw new Error('cursor must be a UUID');
  }
  return {limit: n, cursor: cursor?.toLowerCase()};
}

export function hasParticipant(match, userId) {
  return !!match && typeof userId === 'string' &&
    (match.buyerId === userId || match.sellerId === userId);
}

export function checkTradeSource(trade, match) {
  if (!trade || !match || trade.matchId !== match.id ||
      trade.buyerId !== match.buyerId || trade.sellerId !== match.sellerId) {
    throw new Error('Trade and source Match disagree');
  }
  return true;
}

export function valueToWire(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite value');
    return Number.isSafeInteger(value) ? value : value.toString();
  }
  if (typeof value === 'object' && typeof value.toString === 'function' &&
      ['Decimal', 'Decimal2'].includes(value.constructor?.name)) return value.toString();
  throw new Error('Refusing unknown output type');
}

const MATCH_FIELDS = Object.freeze(['id', 'buyerId', 'sellerId', 'timeSlot', 'quantityWh',
  'unitPriceMicrousdPerKwh', 'totalAmountMicrousd', 'distanceKm', 'score',
  'sellerEnergyType', 'algorithmVersion', 'status', 'createdAt']);
const TRADE_FIELDS = Object.freeze(['id', 'tradeId', 'matchId', 'buyerId', 'sellerId',
  'buyerWallet', 'sellerWallet', 'buyerAddress', 'sellerAddress', 'externalTradeId',
  'onChainTradeId', 'chainId', 'quantityWh', 'unitPriceMicrousdPerKwh',
  'totalAmountMicrousd', 'deliveryStart', 'deliveryDeadline', 'status',
  'contractAddress', 'paymentTokenAddress', 'createTxHash', 'fundTxHash',
  'createdAt', 'updatedAt']);
const DELIVERY_FIELDS = Object.freeze(['id', 'deliveryId', 'tradeId', 'onChainTradeId',
  'buyerId', 'sellerId', 'expectedWh', 'deliveredWh', 'timeSlot', 'timestamp',
  'status', 'evidenceHash', 'createdAt', 'updatedAt']);
const JOURNAL_FIELDS = Object.freeze(['operation', 'status', 'txHash', 'confirmedAt',
  'syncedAt', 'createdAt', 'updatedAt']);

function project(record, fields) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Missing row');
  const out = {};
  for (const k of fields) if (record[k] !== undefined) out[k] = valueToWire(record[k]);
  return out;
}
export const publicMatch = row => project(row, MATCH_FIELDS);
export const publicTrade = row => project(row, TRADE_FIELDS);
export const publicDelivery = row => project(row, DELIVERY_FIELDS);
export function publicIntent(row, phase) {
  const result = project(row, JOURNAL_FIELDS);
  return {phase, ...result};
}

export function paginate(rows, limit, projector) {
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    throw new Error('Invalid page data');
  }
  const included = rows.slice(0, limit);
  return {
    items: included.map(projector),
    nextCursor: rows.length > limit ? String(included[included.length-1].id) : null,
    limit,
  };
}

export function verifyOnChainLink(db, chain) {
  if (!db || !chain || !POSITIVE.test(String(db.onChainTradeId)) ||
      String(chain.onChainTradeId) !== String(db.onChainTradeId)) {
    throw new Error('On-chain trade identifier mismatch');
  }
  for (const key of ['externalTradeId', 'quantityWh', 'unitPriceMicrousdPerKwh', 'totalAmountMicrousd']) {
    if (db[key] !== null && db[key] !== undefined &&
        String(db[key]).toLowerCase() !== String(chain[key]).toLowerCase()) {
      throw new Error(`On-chain ${key} mismatch`);
    }
  }
  for (const [dbField, chainField] of [
    ['buyerWallet', 'buyer'], ['sellerWallet', 'seller'],
    ['buyerAddress', 'buyer'], ['sellerAddress', 'seller'],
  ]) {
    if (db[dbField] !== undefined && db[dbField] !== null) {
      if (!HEX.test(String(db[dbField])) ||
          String(db[dbField]).toLowerCase() !== String(chain[chainField]).toLowerCase()) {
        throw new Error(`On-chain ${chainField} mismatch`);
      }
    }
  }
  return {
    onChainTradeId: String(chain.onChainTradeId),
    chainId: 296,
    onChainStatus: String(chain.status),
    databaseStatus: String(db.status),
    statusAligned: chain.status === db.status,
    quantityWh: String(chain.quantityWh),
    totalAmountMicrousd: String(chain.totalAmountMicrousd),
    deliveredWh: String(chain.deliveredWh),
    evidenceHash: chain.evidenceHash,
    deliveryStart: new Date(Number(chain.deliveryStart)*1000).toISOString(),
    deliveryDeadline: new Date(Number(chain.deliveryDeadline)*1000).toISOString(),
  };
}

export function parsePreflightBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !SUPPORTED_ACTIONS.includes(body.operation)) {
    throw new Error('body must contain only operation: CANCEL | EXPIRE | REFUND | ORACLE_CONFIRM | DB_RECONCILE');
  }
  return {operation: body.operation};
}

/** Indicative state preview only. Never authorizes or executes an EVM operation. */
export function previewOperation({operation, chainStatus, dbStatus, deadline,
  b16Status=null, expireStatus=null, now=Date.now()}) {
  if (!SUPPORTED_ACTIONS.includes(operation)) throw new Error('Unsupported operation');
  if (typeof chainStatus !== 'string' || typeof dbStatus !== 'string') {
    throw new Error('Missing database or chain state');
  }
  const blockers=[];
  if (operation === 'CANCEL') {
    if (chainStatus !== 'CREATED' || dbStatus !== 'CREATED') blockers.push('Only matching CREATED states can be cancelled');
  } else if (operation === 'EXPIRE') {
    if (chainStatus !== 'AWAITING_DELIVERY' || dbStatus !== 'AWAITING_DELIVERY') blockers.push('Trade is not awaiting delivery');
    if (['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED'].includes(b16Status)) {
      blockers.push('Unresolved or completed oracle confirmation must be reconciled first');
    }
    if (!Number.isFinite(Number(deadline)) || !Number.isFinite(now) || now <= Number(deadline)*1000) {
      blockers.push('Deadline not reached on local clock; executor must check chain time and buffer');
    }
  } else if (operation === 'REFUND') {
    if (chainStatus !== 'EXPIRED' || dbStatus !== 'EXPIRED') blockers.push('Trade is not EXPIRED');
    if (expireStatus !== 'CONFIRMED') blockers.push('No confirmed expiration journal');
  } else if (operation === 'ORACLE_CONFIRM') {
    if (chainStatus !== 'AWAITING_DELIVERY' || dbStatus !== 'AWAITING_DELIVERY') blockers.push('Trade is not awaiting delivery');
    if (b16Status !== null && b16Status !== 'REVERTED') blockers.push('Existing oracle journal requires reconciliation');
  } else if (operation === 'DB_RECONCILE') {
    if (!['AWAITING_DELIVERY','COMPLETED','CANCELLED','EXPIRED','REFUNDED'].includes(chainStatus)) blockers.push('Chain state not eligible for supported reconciliation');
  }
  return {
    operation, kind: 'READ_ONLY_POLICY_PREVIEW', candidate: blockers.length === 0,
    blockers, executionAuthorized: false, blockchainWriteRequested: false,
    note: 'Not an execution authorization. Re-run B14/B16/B17 CLI preflight and receipt verification before any transaction or database write.',
  };
}
