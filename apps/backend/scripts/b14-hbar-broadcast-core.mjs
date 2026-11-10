/** B14 Phase B4: pure, testable guards for broadcasting only an existing signed HBAR intent. */
import { decryptSignedTransaction, canonicalIntent, assertBeforeBroadcast, checkTransition } from './b14-intent-journal-core.mjs';
import { requireUuid, requireAddress } from './b14-trade-core.mjs';
import { parseTopUpHbar } from './b14-buyer-hbar-core.mjs';

const MAX_FEE_WEI = 100_000_000_000_000_000n; // 0.1 HBAR
const RESERVE_WEI = 1_000_000_000_000_000_000n;
const MAX_GAS = 250_000n;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

export function parseBroadcastArgs(argv) {
  const required = new Set(['--match-id','--intent-id','--operator-address','--hbar']);
  const data = {};
  for (let i=0; i<argv.length; i++) {
    const flag=argv[i];
    if (flag==='--submit'||flag==='--reconcile') {
      if (data.action) throw new Error('Only one B14 action is permitted');
      data.action = flag.slice(2).toUpperCase();
    } else if (required.has(flag) && !Object.hasOwn(data,flag) && i+1<argv.length && !argv[i+1].startsWith('--')) {
      data[flag] = argv[++i];
    } else { throw new Error(`Unknown, repeated, or incomplete flag: ${flag}`); }
  }
  for (const flag of required) if (!data[flag]) throw new Error(`Missing ${flag}`);
  const amount=parseTopUpHbar(data['--hbar']);
  return { matchId:requireUuid(data['--match-id'],'match-id'), intentId:requireUuid(data['--intent-id'],'intent-id'),
    operatorAddress:requireAddress(data['--operator-address'],'operator-address').toLowerCase(),
    valueWei:amount.valueWei, hbar:data['--hbar'], action:data.action??'PREVIEW' };
}

export function requireBroadcastPermission(args, env) {
  if (args.action==='SUBMIT' && env.B14_BROADCAST_CONFIRM !== 'SEND_EXACT_SIGNED_0_2_TESTNET_HBAR') {
    throw new Error('--submit requires B14_BROADCAST_CONFIRM=SEND_EXACT_SIGNED_0_2_TESTNET_HBAR');
  }
  if (args.action==='RECONCILE' && env.B14_RECONCILE_CONFIRM !== 'RECONCILE_EXISTING_HASH_ONLY') {
    throw new Error('--reconcile requires B14_RECONCILE_CONFIRM=RECONCILE_EXISTING_HASH_ONLY');
  }
  return true;
}

export function expectedTopupIntent(args, externalTradeId, buyerAddress) {
  return canonicalIntent({matchId:args.matchId,operation:'FUND_BUYER_HBAR',externalTradeId,
    signerAddress:args.operatorAddress,targetAddress:buyerAddress,valueWei:args.valueWei,callData:'0x'});
}

export function verifyJournalForB4(row, plan, args) {
  if (!row || row.id?.toLowerCase()!==args.intentId) throw new Error('Existing signed B14 intent ID differs');
  if (row.matchId?.toLowerCase()!==args.matchId || row.operation!=='FUND_BUYER_HBAR' || row.chainId!==296 ||
      row.externalTradeId?.toLowerCase()!==plan.externalTradeId || row.payloadSha256!==plan.payloadSha256 ||
      row.signerAddress?.toLowerCase()!==plan.signerAddress || row.targetAddress?.toLowerCase()!==plan.targetAddress) {
    throw new Error('Signed B14 intent does not match immutable B12 funding plan');
  }
  if (!['SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'].includes(row.status)) {
    throw new Error('B14 B4 requires an existing signed intent; do not sign another');
  }
  // Every post-SIGNED status requires the original signed envelope.
  if (!row.txHash || !row.signedTxCiphertext || !row.signedTxIv || !row.signedTxTag || row.nonce===null || row.nonce===undefined) {
    throw new Error('Signed recovery material incomplete; stop');
  }
  return true;
}

export function decodeVerifiedSigned(row, key, plan, decodeTransaction) {
  if (typeof decodeTransaction !== 'function') throw new Error('Transaction decoder required');
  if (row.status==='SIGNED') assertBeforeBroadcast(row);
  const raw = decryptSignedTransaction({ciphertext:row.signedTxCiphertext,iv:row.signedTxIv,tag:row.signedTxTag},key,row.id);
  const tx = decodeTransaction(raw);
  if (!tx.signature || !tx.hash || tx.hash.toLowerCase()!==row.txHash.toLowerCase() ||
      tx.from?.toLowerCase()!==plan.signerAddress || tx.to?.toLowerCase()!==plan.targetAddress ||
      BigInt(tx.chainId)!==296n || Number(tx.type)!==0 || tx.data!=='0x' ||
      BigInt(tx.value)!==BigInt(plan.valueWei) || !Number.isSafeInteger(tx.nonce) ||
      String(tx.nonce)!==row.nonce || BigInt(tx.gasLimit)<21_000n || BigInt(tx.gasLimit)>MAX_GAS ||
      BigInt(tx.gasPrice??0n)<=0n || BigInt(tx.gasLimit)*BigInt(tx.gasPrice)>MAX_FEE_WEI) {
    throw new Error('Decrypted transaction does not match stored hash, nonce, signer, target, amount or safety cap');
  }
  return {raw,tx,hash:tx.hash.toLowerCase(),nonce:tx.nonce,maxFeeWei:BigInt(tx.gasLimit)*BigInt(tx.gasPrice)};
}

export function verifyNetworkTx(observed, signed) {
  if (!observed) return false;
  if (observed.hash?.toLowerCase()!==signed.hash || observed.from?.toLowerCase()!==signed.tx.from?.toLowerCase() ||
      observed.to?.toLowerCase()!==signed.tx.to?.toLowerCase() ||
      Number(observed.nonce)!==signed.nonce || BigInt(observed.value)!==BigInt(signed.tx.value) ||
      (observed.data??'0x')!=='0x') {
    throw new Error('RPC transaction with stored hash differs from persisted signed transfer');
  }
  return true;
}

export function receiptOutcome(receipt, signed) {
  if (!receipt) return null;
  const hash=(receipt.hash??receipt.transactionHash)?.toLowerCase();
  if (hash!==signed.hash || receipt.from?.toLowerCase()!==signed.tx.from?.toLowerCase() ||
      receipt.to?.toLowerCase()!==signed.tx.to?.toLowerCase() ||
      !Number.isInteger(receipt.blockNumber) || receipt.blockNumber<0 ||
      (receipt.status!==0 && receipt.status!==1)) {
    throw new Error('Transaction receipt missing expected hash/parties/final status');
  }
  return receipt.status===1?'CONFIRMED':'REVERTED';
}

export function observedState({receipt,networkTx,nonceLatest,noncePending}, signed) {
  const outcome=receiptOutcome(receipt,signed);
  if (networkTx) verifyNetworkTx(networkTx,signed);
  if (outcome) return outcome;
  if (networkTx) return 'PENDING_OR_INDEXING';
  const l=BigInt(nonceLatest),p=BigInt(noncePending),nonce=BigInt(signed.nonce);
  if (l!==nonce || p!==nonce) return 'NONCE_MISMATCH_UNKNOWN';
  return 'ABSENT_AT_RPC';
}

export function assertSubmitAllowed(row,state,operatorBalanceWei,signed) {
  if (row.status!=='SIGNED') throw new Error('Only exactly SIGNED intent can be submitted; reconcile other states');
  if (state!=='ABSENT_AT_RPC') throw new Error(`Refusing broadcast because on-chain state is ${state}; reconcile first`);
  if (BigInt(operatorBalanceWei)<BigInt(signed.tx.value)+signed.maxFeeWei+RESERVE_WEI) {
    throw new Error('Operator would breach 1 HBAR minimum reserve including max gas budget');
  }
  checkTransition('SIGNED','SUBMITTED');
  return true;
}

export function assertRelayHash(value, signedHash) {
  if (typeof value!=='string'||!TX_HASH.test(value)||value.toLowerCase()===ZERO_HASH||value.toLowerCase()!==signedHash.toLowerCase()) {
    throw new Error('Hedera relay returned missing/zero/different transaction hash; reconcile exact signed hash');
  }
  return true;
}

export function decideReconciliation(row,status) {
  if (!['SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'].includes(row.status)) throw new Error('Unexpected persisted B14 state');
  if (['CONFIRMED','REVERTED'].includes(row.status)) {
    if (status!==row.status) throw new Error('Terminal journal status conflicts with RPC state; manual investigation required');
    return null;
  }
  if (status==='CONFIRMED'||status==='REVERTED') {
    checkTransition(row.status,status); return status;
  }
  if (status==='PENDING_OR_INDEXING') {
    if (row.status==='SIGNED'||row.status==='NEEDS_RECONCILIATION') {
      checkTransition(row.status,'SUBMITTED'); return 'SUBMITTED';
    }
    return null;
  }
  if (status==='ABSENT_AT_RPC'||status==='NONCE_MISMATCH_UNKNOWN') {
    if (row.status==='SUBMITTED') { checkTransition('SUBMITTED','NEEDS_RECONCILIATION'); return 'NEEDS_RECONCILIATION'; }
    return null;
  }
  throw new Error('Unknown reconciliation observation');
}

export function sanitizeBroadcastError(error) {
  // Avoid persisting RPC bodies, raw transaction bytes or credentials in DB logs.
  const code=typeof error?.code==='string' ? error.code.slice(0,48) : 'RPC_ERROR';
  return `B14 relay submission uncertain (${code}); reconcile the persisted transaction hash`;
}
