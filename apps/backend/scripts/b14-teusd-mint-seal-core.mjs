/** B14 B5-B: pure TEUSD mint sealing gates. No network, DB, private keys or broadcast. */
import { compareImmutableIntent } from './b14-intent-journal-core.mjs';
import { requireUuid, requireAddress, requireUint } from './b14-trade-core.mjs';
import { REQUIRED_ADMIN_RESERVE_WEI, exactMintCalldata } from './b14-teusd-mint-core.mjs';

export const MINT_MAX_GAS_LIMIT = 600_000n;
export const MINT_MAX_FEE_WEI = 750_000_000_000_000_000n; // 0.75 Testnet HBAR
const MAX_SAFE_NONCE = BigInt(Number.MAX_SAFE_INTEGER);
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseMintSealArgs(argv) {
  const required = ['--match-id','--intent-id','--admin-address'];
  const allowed = new Set(required);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seal') {
      if (values.seal) throw new Error('Repeated --seal');
      values.seal = true;
      continue;
    }
    if (!allowed.has(arg) || Object.hasOwn(values,arg) || i + 1 >= argv.length || argv[i+1].startsWith('--')) {
      throw new Error(`Unknown, repeated, or incomplete B5-B argument: ${arg}`);
    }
    values[arg] = argv[++i];
  }
  for (const arg of required) if (!values[arg]) throw new Error(`Missing ${arg}`);
  return {
    matchId: requireUuid(values['--match-id'],'match-id'),
    intentId: requireUuid(values['--intent-id'],'intent-id'),
    adminAddress: requireAddress(values['--admin-address'],'admin-address').toLowerCase(),
    seal: values.seal === true,
  };
}

export function requireMintSealPermission(args,env) {
  if (!args.seal) return false;
  if (env.B14_SEAL_MINT_CONFIRM !== 'YES_SIGN_EXACT_TEUSD_MINT_DO_NOT_SEND') {
    throw new Error('--seal requires B14_SEAL_MINT_CONFIRM=YES_SIGN_EXACT_TEUSD_MINT_DO_NOT_SEND');
  }
  return true;
}

export function verifyPlannedMintJournal(row,plan,intentId) {
  if (!row || row.id?.toLowerCase() !== intentId.toLowerCase() || row.operation !== 'MINT_TEUSD') {
    throw new Error('Expected exact existing MINT_TEUSD journal intent');
  }
  if (!HASH.test(row.externalTradeId ?? '') || row.externalTradeId.toLowerCase() !== plan.externalTradeId) {
    throw new Error('Existing mint externalTradeId differs from committed B12 match');
  }
  compareImmutableIntent(row,plan);
  if (row.txHash !== null || row.nonce !== null || row.signedTxCiphertext !== null ||
    row.signedTxIv !== null || row.signedTxTag !== null || row.confirmedAt !== null) {
    throw new Error('PLANNED mint journal unexpectedly has signed or confirmed fields');
  }
  return true;
}

export function requireCleanMintSignerQueue(rows,expectedId) {
  if (!Array.isArray(rows)) throw new Error('Signer queue data missing');
  if (rows.some(r => r.id !== expectedId && ['SIGNED','SUBMITTED','NEEDS_RECONCILIATION'].includes(r.status))) {
    throw new Error('Other unresolved B14 transaction uses admin signing account; reconcile first');
  }
  return true;
}

export function requireMintNonce(latest,pending) {
  const l=requireUint(latest,'latest admin nonce');
  const p=requireUint(pending,'pending admin nonce');
  if (l !== p) throw new Error('Admin has pending network transactions; do not sign');
  if (l > MAX_SAFE_NONCE) throw new Error('Admin nonce exceeds Number.MAX_SAFE_INTEGER');
  return Number(l);
}

export function safeMintGasQuote({estimatedGas,gasPriceWei,adminBalanceWei}) {
  const estimate=requireUint(estimatedGas,'gas estimate',{positive:true});
  const price=requireUint(gasPriceWei,'gas price',{positive:true});
  const balance=requireUint(adminBalanceWei,'admin HBAR balance');
  const gasLimit=(estimate*120n+99n)/100n;
  if (gasLimit > MINT_MAX_GAS_LIMIT) throw new Error('Mint gas limit exceeds 600,000 B14 cap');
  const maxFeeWei=gasLimit*price;
  if (maxFeeWei > MINT_MAX_FEE_WEI) throw new Error('Potential mint network fee exceeds 0.75 Testnet HBAR cap');
  if (balance < maxFeeWei + REQUIRED_ADMIN_RESERVE_WEI) {
    throw new Error('Admin would fall below 1 HBAR reserve after potential fee');
  }
  return {gasLimit,gasPriceWei:price,maxFeeWei};
}

export function makeUnsignedMint({chainId,adminAddress,tokenAddress,buyerAddress,amountUnits,callData,nonce,gasLimit,gasPriceWei}) {
  if (BigInt(chainId)!==296n) throw new Error('Refuse non-Hedera-Testnet mint');
  const admin=requireAddress(adminAddress,'admin address').toLowerCase();
  const token=requireAddress(tokenAddress,'token address').toLowerCase();
  const buyer=requireAddress(buyerAddress,'buyer address').toLowerCase();
  if (admin===token || admin===buyer || token===buyer) throw new Error('Invalid mint signer, token, or buyer mapping');
  const expected=exactMintCalldata(buyer,amountUnits);
  if (typeof callData!=='string'||callData.toLowerCase()!==expected) {
    throw new Error('Mint calldata does not match exact buyer + exact six-decimal amount');
  }
  const n=requireMintNonce(nonce,nonce);
  const limit=requireUint(gasLimit,'gas limit',{positive:true});
  const price=requireUint(gasPriceWei,'gas price',{positive:true});
  if (limit > MINT_MAX_GAS_LIMIT || limit*price > MINT_MAX_FEE_WEI) {
    throw new Error('Unsigned mint exceeds configured fee/gas caps');
  }
  return {chainId:296,type:0,to:token,data:expected,value:0n,nonce:n,gasLimit:limit,gasPrice:price};
}

export function verifySignedMintEnvelope(decoded,expected,expectedSigner) {
  if (!decoded || typeof decoded.hash!=='string' || !HASH.test(decoded.hash)) throw new Error('Signed mint transaction hash missing');
  if (decoded.from?.toLowerCase()!==requireAddress(expectedSigner,'minter').toLowerCase()) throw new Error('Signed mint signer differs');
  if (BigInt(decoded.chainId)!==296n || Number(decoded.type)!==0 ||
    Number(decoded.nonce)!==expected.nonce || decoded.to?.toLowerCase()!==expected.to.toLowerCase() ||
    BigInt(decoded.value)!==0n || BigInt(decoded.gasLimit)!==BigInt(expected.gasLimit) ||
    BigInt(decoded.gasPrice)!==BigInt(expected.gasPrice) ||
    decoded.data?.toLowerCase()!==expected.data.toLowerCase()) {
    throw new Error('Signed TEUSD mint has altered chain, nonce, fee, contract, value, recipient or token amount');
  }
  return decoded.hash.toLowerCase();
}
