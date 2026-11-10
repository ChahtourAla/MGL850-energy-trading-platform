/** B14 Phase B3: pure signer readiness & sealing gates. No IO, keys or broadcast. */
import { compareImmutableIntent } from './b14-intent-journal-core.mjs';
import { requireUuid, requireAddress } from './b14-trade-core.mjs';
import { parseTopUpHbar } from './b14-buyer-hbar-core.mjs';

const MAX_GAS_LIMIT = 250_000n;
const MAX_HBAR_FEE_WEI = 100_000_000_000_000_000n; // 0.1 HBAR hard ceiling
const MIN_OPERATOR_RESERVE_WEI = 1_000_000_000_000_000_000n; // 1 HBAR
const MAX_SAFE_NONCE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseHbarSealArgs(argv) {
  const allowed = new Set(['--match-id', '--intent-id', '--operator-address', '--hbar']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seal') {
      if (args.seal) throw new Error('Repeated --seal');
      args.seal = true;
      continue;
    }
    if (!allowed.has(arg) || Object.hasOwn(args, arg) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown, repeated or missing argument: ${arg}`);
    }
    args[arg] = argv[++i];
  }
  for (const key of allowed) {
    if (!args[key]) throw new Error(`Missing required ${key}`);
  }
  const { valueWei } = parseTopUpHbar(args['--hbar']);
  return {
    matchId: requireUuid(args['--match-id'], 'match-id'),
    intentId: requireUuid(args['--intent-id'], 'intent-id'),
    operatorAddress: requireAddress(args['--operator-address'], 'operator-address').toLowerCase(),
    valueWei,
    hbar: args['--hbar'],
    seal: args.seal === true,
  };
}

export function requireSealPermission(args, env) {
  if (!args.seal) return false;
  if (env.B14_SEAL_INTENT_CONFIRM !== 'YES_SIGN_BUT_DO_NOT_SEND') {
    throw new Error('--seal requires B14_SEAL_INTENT_CONFIRM=YES_SIGN_BUT_DO_NOT_SEND');
  }
  return true;
}

export function verifyStagedIntent(row, plan, intentId) {
  if (!row || row.id?.toLowerCase() !== intentId.toLowerCase()) throw new Error('Expected exact existing B14 intent ID');
  if (row.operation !== 'FUND_BUYER_HBAR') throw new Error('Intent operation is not FUND_BUYER_HBAR');
  if (row.externalTradeId?.toLowerCase() !== plan.externalTradeId) throw new Error('External trade ID changed');
  compareImmutableIntent(row, plan);
  if (row.txHash || row.nonce !== null || row.signedTxCiphertext || row.signedTxIv || row.signedTxTag) {
    throw new Error('PLANNED intent unexpectedly contains signed material; stop');
  }
  return true;
}

export function requireCleanSignerQueue(rows, currentIntentId) {
  if (!Array.isArray(rows)) throw new Error('Signer queue must be an array');
  for (const row of rows) {
    if (row.id === currentIntentId) continue;
    if (['SIGNED', 'SUBMITTED', 'NEEDS_RECONCILIATION'].includes(row.status)) {
      throw new Error('An unresolved intent uses this signer; reconcile it before signing another transaction');
    }
  }
  return true;
}

function unsigned(v, label) {
  const s = typeof v === 'bigint' ? v.toString() : String(v);
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > 78) throw new Error(`${label} must be unsigned integer`);
  return BigInt(s);
}

export function requireNonce(latest, pending) {
  const l = unsigned(latest, 'latest nonce');
  const p = unsigned(pending, 'pending nonce');
  if (l !== p) throw new Error('Signer has pending on-chain transactions; reconcile before signing');
  if (l > MAX_SAFE_NONCE) throw new Error('Nonce exceeds safe JS integer range');
  return Number(l);
}

export function computeSafeGasQuote({ estimateGas, gasPriceWei, senderBalanceWei, valueWei }) {
  const estimated = unsigned(estimateGas, 'gas estimate');
  const gasPrice = unsigned(gasPriceWei, 'gas price');
  const balance = unsigned(senderBalanceWei, 'operator balance');
  const value = unsigned(valueWei, 'transfer amount');
  if (estimated === 0n || gasPrice === 0n) throw new Error('Gas estimate and gas price must be positive');
  const gasLimit = (estimated * 120n + 99n) / 100n;
  if (gasLimit > MAX_GAS_LIMIT) throw new Error('Gas limit above B14 HBAR funding safety limit');
  const maxFeeWei = gasLimit * gasPrice;
  if (maxFeeWei > MAX_HBAR_FEE_WEI) throw new Error('Potential gas fee exceeds 0.1 HBAR cap');
  if (balance < value + maxFeeWei + MIN_OPERATOR_RESERVE_WEI) {
    throw new Error('Operator would fall below 1 HBAR reserve after worst-case fees');
  }
  return { gasLimit, gasPriceWei: gasPrice, maxFeeWei };
}

export function makeUnsignedTopup({ chainId, signerAddress, targetAddress, valueWei, nonce, gasLimit, gasPriceWei }) {
  if (BigInt(chainId) !== 296n) throw new Error('Wrong chain ID for signed transfer');
  const signer = requireAddress(signerAddress, 'signer').toLowerCase();
  const target = requireAddress(targetAddress, 'target').toLowerCase();
  if (signer === target) throw new Error('Cannot send HBAR to the signer');
  const n = requireNonce(nonce, nonce);
  const value = unsigned(valueWei, 'value');
  const limit = unsigned(gasLimit, 'gas limit');
  const price = unsigned(gasPriceWei, 'gas price');
  if (limit === 0n || limit > MAX_GAS_LIMIT || price === 0n || value === 0n) throw new Error('Invalid gas/value on transfer');
  return { chainId: 296, type: 0, to: target, data: '0x', value, nonce: n, gasLimit: limit, gasPrice: price };
}

export function verifySignedEnvelope(decoded, expected, expectedSigner) {
  if (!decoded?.hash || !/^0x[0-9a-fA-F]{64}$/.test(decoded.hash)) throw new Error('Signed transaction hash missing');
  if (decoded.from?.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error('Signed transaction has different sender');
  if (BigInt(decoded.chainId) !== BigInt(expected.chainId) || Number(decoded.type) !== 0 ||
      Number(decoded.nonce) !== expected.nonce || decoded.to?.toLowerCase() !== expected.to.toLowerCase() ||
      BigInt(decoded.value) !== expected.value || BigInt(decoded.gasLimit) !== expected.gasLimit ||
      BigInt(decoded.gasPrice) !== expected.gasPrice || (decoded.data || '0x') !== '0x') {
    throw new Error('Signed transaction envelope differs from approved HBAR top-up');
  }
  return decoded.hash.toLowerCase();
}
