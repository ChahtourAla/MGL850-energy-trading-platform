/** B14 phase B2: pure buyer-HBAR intent planning. No keys, no RPC, no DB writes. */
import { canonicalIntent, compareImmutableIntent } from './b14-intent-journal-core.mjs';
import { requireAddress, requireUuid, requireUint } from './b14-trade-core.mjs';

export const MIN_BUYER_TOPUP_TINYBAR = 10_000_000n;  // 0.1 HBAR
export const MAX_BUYER_TOPUP_TINYBAR = 100_000_000n; // 1.0 HBAR hard cap per selected match
export const TINYBAR_TO_WEI = 10_000_000_000n;
export const CHAIN_ID = 296;

export function parseTopUpHbar(value) {
  if (typeof value !== 'string' || !/^(?:0|1)(?:\.\d{1,8})?$/.test(value)) {
    throw new Error('--hbar must be an ordinary decimal with at most 8 fractional digits');
  }
  const [whole, fractional = ''] = value.split('.');
  const tinybar = BigInt(whole) * 100_000_000n + BigInt(fractional.padEnd(8, '0') || '0');
  if (tinybar < MIN_BUYER_TOPUP_TINYBAR || tinybar > MAX_BUYER_TOPUP_TINYBAR) {
    throw new Error('B14 buyer top-up must be between 0.1 and 1 HBAR, inclusive');
  }
  return { tinybar, valueWei: (tinybar * TINYBAR_TO_WEI).toString() };
}

export function parseBuyerTopupArgs(argv) {
  const keys = new Set(['--match-id', '--operator-address', '--hbar']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--stage') {
      if (args.stage) throw new Error('Repeated --stage');
      args.stage = true;
      continue;
    }
    if (!keys.has(k) || Object.hasOwn(args,k) || i+1 >= argv.length || argv[i+1].startsWith('--')) {
      throw new Error(`Unknown, repeated or missing option: ${k}`);
    }
    args[k] = argv[++i];
  }
  if (!args['--match-id'] || !args['--operator-address'] || !args['--hbar']) {
    throw new Error('Required: --match-id <UUID> --operator-address <public 0x...> --hbar <0.1..1> [--stage]');
  }
  return {
    matchId: requireUuid(args['--match-id'], 'match-id'),
    operatorAddress: requireAddress(args['--operator-address'],'operator-address'),
    ...parseTopUpHbar(args['--hbar']),
    hbar: args['--hbar'], stage: args.stage === true,
  };
}

export function prepareBuyerTopup({ matchId, buyerAddress, operatorAddress, externalTradeId, topupWei,
  buyerBalanceWei, operatorBalanceWei, operatorHasRole, networkChainId, existingLocalTrade,
  existingOnChainId, matchStatus, maxExistingBuyerWei = '0' }) {
  if (networkChainId !== CHAIN_ID) throw new Error('Hedera network mismatch: expected 296');
  if (operatorHasRole !== true) throw new Error('Operator lacks OPERATOR_ROLE');
  if (matchStatus !== 'SELECTED') throw new Error('Match is not SELECTED');
  if (existingLocalTrade) throw new Error('Existing PostgreSQL trade: reconcile, do not plan a new funding action');
  if (existingOnChainId !== '0') throw new Error('Existing on-chain trade: reconcile before proceeding');
  const buyer = requireAddress(buyerAddress,'buyer-address');
  const operator = requireAddress(operatorAddress,'operator-address');
  if (buyer.toLowerCase()===operator.toLowerCase()) throw new Error('Operator and buyer must differ');
  const amount = requireUint(topupWei,'topupWei',{positive:true});
  if (amount < MIN_BUYER_TOPUP_TINYBAR*TINYBAR_TO_WEI || amount > MAX_BUYER_TOPUP_TINYBAR*TINYBAR_TO_WEI || amount%TINYBAR_TO_WEI !== 0n) {
    throw new Error('HBAR amount is outside safe tinybar limits');
  }
  const buyerBalance = requireUint(buyerBalanceWei,'buyerBalanceWei');
  const operatorBalance = requireUint(operatorBalanceWei,'operatorBalanceWei');
  const ceiling = requireUint(maxExistingBuyerWei,'maxExistingBuyerWei');
  // A conservative guard: do not fund a buyer which already has the fee reserve.
  if (buyerBalance >= ceiling && ceiling > 0n) throw new Error('Buyer HBAR balance already at/above configured funding threshold');
  if (operatorBalance < amount + 1_000_000_000_000_000_000n) {
    throw new Error('Operator must retain at least 1 HBAR as a safety buffer');
  }
  return canonicalIntent({
    matchId, operation:'FUND_BUYER_HBAR', externalTradeId, signerAddress:operator,
    targetAddress:buyer, valueWei:amount.toString(), callData:'0x',
  });
}

export function checkStagingPermission(args, env) {
  if (!args.stage) return false;
  if (env.B14_STAGE_INTENT_CONFIRM !== 'YES') {
    throw new Error('--stage requires B14_STAGE_INTENT_CONFIRM=YES; no database changes made');
  }
  return true;
}

export function existingTopupDisposition(row, plan) {
  if (!row) return 'CREATE';
  compareImmutableIntent(row,plan);
  return 'UNCHANGED';
}
