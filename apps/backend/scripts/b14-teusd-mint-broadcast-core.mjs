/** B14 B5-C: pure verification gates for one pre-signed mint transaction. */
import { canonicalIntent, decryptSignedTransaction, assertBeforeBroadcast, checkTransition } from './b14-intent-journal-core.mjs';
import { requireUuid, requireAddress, requireUint } from './b14-trade-core.mjs';
import { exactMintCalldata, MAX_PROTOTYPE_TEUSD_MICRO, REQUIRED_ADMIN_RESERVE_WEI } from './b14-teusd-mint-core.mjs';
import { MINT_MAX_FEE_WEI, MINT_MAX_GAS_LIMIT, verifySignedMintEnvelope, makeUnsignedMint } from './b14-teusd-mint-seal-core.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = `0x${'0'.repeat(40)}`;
const ACTIVE = new Set(['SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED']);
const STATES = new Set(['ABSENT_AT_RPC','NONCE_MISMATCH_UNKNOWN','PENDING_OR_INDEXING','CONFIRMED','REVERTED']);

export function parseMintBroadcastArgs(argv) {
  const names=new Set(['--match-id','--intent-id','--admin-address']);
  const opts={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--submit'||key==='--reconcile') {
      if(opts.action)throw new Error('Only one B5-C action allowed');
      opts.action=key.slice(2).toUpperCase();
    } else if(names.has(key) && !Object.hasOwn(opts,key) && i+1<argv.length && !argv[i+1].startsWith('--')){
      opts[key]=argv[++i];
    } else throw new Error(`Unknown/repeated/incomplete B5-C flag ${key}`);
  }
  for(const name of names)if(!opts[name])throw new Error(`Missing ${name}`);
  return {matchId:requireUuid(opts['--match-id'],'match-id'),
    intentId:requireUuid(opts['--intent-id'],'intent-id'),
    adminAddress:requireAddress(opts['--admin-address'],'admin-address').toLowerCase(),
    action:opts.action??'PREVIEW'};
}
export function requireMintBroadcastPermission(args,env) {
  if(args.action==='SUBMIT' && env.B14_BROADCAST_MINT_CONFIRM!=='SEND_EXACT_SIGNED_250232_TEUSD_MINT'){
    throw new Error('Mint --submit requires B14_BROADCAST_MINT_CONFIRM=SEND_EXACT_SIGNED_250232_TEUSD_MINT');
  }
  if(args.action==='RECONCILE' && env.B14_RECONCILE_MINT_CONFIRM!=='RECONCILE_EXISTING_MINT_HASH_ONLY'){
    throw new Error('Mint --reconcile requires B14_RECONCILE_MINT_CONFIRM=RECONCILE_EXISTING_MINT_HASH_ONLY');
  }
  return true;
}
export function canonicalMintPlan({matchId,externalTradeId,adminAddress,tokenAddress,buyerAddress,amountUnits}) {
  return canonicalIntent({matchId,operation:'MINT_TEUSD',externalTradeId,
    signerAddress:adminAddress,targetAddress:tokenAddress,valueWei:'0',
    callData:exactMintCalldata(buyerAddress,amountUnits)});
}
export function verifyStoredMint(row,plan,intentId) {
  if(!row || row.id?.toLowerCase()!==intentId || row.matchId?.toLowerCase()!==plan.matchId ||
      row.operation!=='MINT_TEUSD' || row.chainId!==296 ||
      row.externalTradeId?.toLowerCase()!==plan.externalTradeId ||
      row.signerAddress?.toLowerCase()!==plan.signerAddress ||
      row.targetAddress?.toLowerCase()!==plan.targetAddress ||
      row.payloadSha256!==plan.payloadSha256)throw new Error('Signed mint journal differs from immutable B12 plan');
  if(!ACTIVE.has(row.status))throw new Error('B5-C requires a signed mint journal (never mint another)');
  if(!HASH.test(row.txHash??'') || !row.signedTxCiphertext || !row.signedTxIv || !row.signedTxTag ||
      row.nonce===null || row.nonce===undefined || !/^(0|[1-9]\d*)$/.test(String(row.nonce))) {
    throw new Error('Mint encrypted signing material or hash missing');
  }
  return true;
}
export function decodeVerifiedMint(row,key,plan,buyerAddress,amountUnits,decodeTransaction) {
  if(typeof decodeTransaction!=='function')throw new Error('Missing signed transaction decoder');
  if(row.status==='SIGNED')assertBeforeBroadcast(row);
  const raw=decryptSignedTransaction({ciphertext:row.signedTxCiphertext,iv:row.signedTxIv,tag:row.signedTxTag},key,row.id);
  const tx=decodeTransaction(raw);
  if(!tx?.signature || !tx.hash || !HASH.test(tx.hash) || tx.hash.toLowerCase()!==row.txHash.toLowerCase()) {
    throw new Error('Persisted mint hash does not match decrypted signature');
  }
  const nonce=Number(row.nonce);
  if(!Number.isSafeInteger(nonce) || nonce<0 || String(nonce)!==String(row.nonce))throw new Error('Stored mint nonce invalid');
  const expected=makeUnsignedMint({chainId:296,adminAddress:plan.signerAddress,
    tokenAddress:plan.targetAddress,buyerAddress,amountUnits,
    callData:plan.callData,nonce,gasLimit:tx.gasLimit,gasPriceWei:tx.gasPrice});
  const hash=verifySignedMintEnvelope(tx,expected,plan.signerAddress);
  if(hash!==row.txHash.toLowerCase())throw new Error('Signed mint hash mismatch');
  return {raw,tx,hash,nonce,maxFeeWei:BigInt(tx.gasLimit)*BigInt(tx.gasPrice)};
}
export function verifyMintNetworkTransaction(networkTx,signed) {
  if(!networkTx)return false;
  if(networkTx.hash?.toLowerCase()!==signed.hash ||
      networkTx.from?.toLowerCase()!==signed.tx.from?.toLowerCase() ||
      networkTx.to?.toLowerCase()!==signed.tx.to?.toLowerCase() ||
      Number(networkTx.nonce)!==signed.nonce ||
      BigInt(networkTx.chainId??0)!==296n ||
      BigInt(networkTx.value??-1)!==0n ||
      networkTx.data?.toLowerCase()!==signed.tx.data?.toLowerCase()) {
    throw new Error('On-chain transaction differs from exact stored signed mint');
  }
  return true;
}
export function verifyMintReceipt(receipt,signed) {
  if(!receipt)return null;
  const hash=(receipt.hash??receipt.transactionHash)?.toLowerCase();
  if(hash!==signed.hash || receipt.from?.toLowerCase()!==signed.tx.from?.toLowerCase() ||
      receipt.to?.toLowerCase()!==signed.tx.to?.toLowerCase() ||
      !Number.isInteger(receipt.blockNumber)||receipt.blockNumber<0 ||
      ![0,1].includes(receipt.status))throw new Error('Mint receipt does not match signed transaction');
  return receipt.status===1?'CONFIRMED':'REVERTED';
}
export function observedMintState({receipt,networkTx,nonceLatest,noncePending},signed) {
  const status=verifyMintReceipt(receipt,signed);
  if(networkTx)verifyMintNetworkTransaction(networkTx,signed);
  if(status)return status;
  if(networkTx)return 'PENDING_OR_INDEXING';
  const nonce=BigInt(signed.nonce);
  return BigInt(nonceLatest)===nonce && BigInt(noncePending)===nonce?'ABSENT_AT_RPC':'NONCE_MISMATCH_UNKNOWN';
}
/** Verify receipt Transfer(0x0,buyer,amount) + current exact buyer balance before persisting success. */
export function requireMintEffect({events,buyerBalanceUnits,tokenAddress,buyerAddress,amountUnits}) {
  const buyer=requireAddress(buyerAddress,'buyer').toLowerCase();
  const token=requireAddress(tokenAddress,'token').toLowerCase();
  const amount=requireUint(amountUnits,'mint units',{positive:true});
  if(amount>MAX_PROTOTYPE_TEUSD_MICRO)throw new Error('Mint exceeds prototype cap');
  const matching=(events??[]).filter(e=>e.contract==='TestEnergyUSD' && e.event==='Transfer' &&
    e.address?.toLowerCase()===token && e.args?.from?.toLowerCase()===ZERO &&
    e.args?.to?.toLowerCase()===buyer && String(e.args?.value)===String(amount));
  if(matching.length!==1)throw new Error('Confirmed mint receipt lacks one exact Transfer(zero,buyer,amount) event');
  if(requireUint(buyerBalanceUnits,'buyer balance')!==amount){
    throw new Error('Buyer TEUSD balance differs from exact confirmed mint amount: manual investigation');
  }
  return true;
}
export function requireMintSubmitAllowed({row,state,adminBalanceWei,buyerBalanceUnits,signed,hasMinterRole,escrowPaused,tradeId,localTrade,matchStatus,otherActiveCount}) {
  if(row.status!=='SIGNED'||state!=='ABSENT_AT_RPC')throw new Error('Only absent-at-RPC SIGNED mint may be submitted');
  if(BigInt(buyerBalanceUnits)!==0n)throw new Error('Buyer already has TEUSD: do not mint again');
  if(hasMinterRole!==true||escrowPaused!==false||tradeId!=='0'||localTrade||matchStatus!=='SELECTED') {
    throw new Error('Mint authorization or trade state changed; stop');
  }
  if(otherActiveCount!==0)throw new Error('Another unresolved admin signing intent exists');
  if(signed.maxFeeWei>MINT_MAX_FEE_WEI || BigInt(signed.tx.gasLimit)>MINT_MAX_GAS_LIMIT) {
    throw new Error('Mint exceeds transaction fee caps');
  }
  if(BigInt(adminBalanceWei)<signed.maxFeeWei+REQUIRED_ADMIN_RESERVE_WEI){
    throw new Error('Admin must retain 1 HBAR reserve after quoted gas');
  }
  checkTransition('SIGNED','SUBMITTED');
  return true;
}
export function assertMintRelayHash(received,expected) {
  if(typeof received!=='string'||!HASH.test(received)||/^0x0{64}$/i.test(received)||received.toLowerCase()!==expected.toLowerCase()){
    throw new Error('Relay returned missing/incorrect mint hash; reconcile exact journal');
  }
  return true;
}
export function decideMintReconciliation(row,state) {
  if(!ACTIVE.has(row.status) || !STATES.has(state))throw new Error('Invalid journal/chain observation');
  if(row.status==='CONFIRMED'||row.status==='REVERTED'){
    if(row.status!==state)throw new Error('Terminal mint journal conflicts with network state');
    return null;
  }
  if(state==='CONFIRMED'||state==='REVERTED'){
    checkTransition(row.status,state);return state;
  }
  if(state==='PENDING_OR_INDEXING'){
    if(row.status==='SIGNED'||row.status==='NEEDS_RECONCILIATION'){
      checkTransition(row.status,'SUBMITTED');return 'SUBMITTED';
    }
    return null;
  }
  if((state==='ABSENT_AT_RPC'||state==='NONCE_MISMATCH_UNKNOWN') && row.status==='SUBMITTED'){
    checkTransition(row.status,'NEEDS_RECONCILIATION');return 'NEEDS_RECONCILIATION';
  }
  return null;
}
export function sanitizeMintRpcError(error) {
  const code=typeof error?.code==='string'?error.code.slice(0,48):'RPC_ERROR';
  return `B14 mint broadcast uncertain (${code}); reconcile exact stored mint hash`;
}
