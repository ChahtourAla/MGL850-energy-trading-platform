/** B14 B5-A: pure TEUSD mint-intent planning. No RPC, database, keys, signing or broadcast. */
import { canonicalIntent, compareImmutableIntent } from './b14-intent-journal-core.mjs';
import { requireAddress, requireUuid, requireUint } from './b14-trade-core.mjs';

export const B14_CHAIN = 296;
export const MINT_SELECTOR = '0x40c10f19'; // keccak256('mint(address,uint256)') first four bytes
export const REQUIRED_BUYER_HBAR_WEI = 100_000_000_000_000_000n; // 0.1 HBAR
export const REQUIRED_ADMIN_RESERVE_WEI = 1_000_000_000_000_000_000n; // 1 HBAR
export const MAX_PROTOTYPE_TEUSD_MICRO = 10_000_000n; // 10 test TEUSD
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseMintArgs(argv) {
  const values = {};
  for (let i=0; i<argv.length; i++) {
    const key=argv[i];
    if (key==='--stage') {
      if (values.stage) throw new Error('Repeated --stage');
      values.stage=true;
    } else if (['--match-id','--admin-address'].includes(key) && !Object.hasOwn(values,key) &&
      i+1<argv.length && !argv[i+1].startsWith('--')) {
      values[key]=argv[++i];
    } else {
      throw new Error(`Unknown, repeated, or incomplete argument: ${key}`);
    }
  }
  if (!values['--match-id'] || !values['--admin-address']) {
    throw new Error('Required: --match-id UUID --admin-address PUBLIC_EVM_ADDRESS [--stage]');
  }
  return {matchId:requireUuid(values['--match-id'],'match-id'),
    adminAddress:requireAddress(values['--admin-address'],'admin-address').toLowerCase(),
    stage:values.stage===true};
}

export function requireMintStagePermission(args,env) {
  if (!args.stage) return false;
  if (env.B14_STAGE_MINT_CONFIRM!=='STAGE_EXACT_TEUSD_MINT_NO_TX') {
    throw new Error('--stage requires B14_STAGE_MINT_CONFIRM=STAGE_EXACT_TEUSD_MINT_NO_TX');
  }
  return true;
}

export function exactMintCalldata(buyerAddress,amountUnits) {
  const buyer=requireAddress(buyerAddress,'buyer address').slice(2).toLowerCase();
  const amount=requireUint(amountUnits,'mint amount',{positive:true});
  if (amount>MAX_PROTOTYPE_TEUSD_MICRO) throw new Error('Mint exceeds 10 TEUSD B14 prototype cap');
  return MINT_SELECTOR+buyer.padStart(64,'0')+amount.toString(16).padStart(64,'0');
}

export function requireConfirmedBuyerHbar(row,{matchId,externalTradeId,operatorAddress,buyerAddress}) {
  if (!row || row.operation!=='FUND_BUYER_HBAR' || row.status!=='CONFIRMED' ||
    row.matchId?.toLowerCase()!==matchId.toLowerCase() || row.chainId!==B14_CHAIN ||
    row.externalTradeId?.toLowerCase()!==externalTradeId.toLowerCase() ||
    !HASH.test(row.txHash??'') || row.nonce===null || row.nonce===undefined ||
    !(row.confirmedAt instanceof Date) || !Number.isFinite(row.confirmedAt.getTime())) {
    throw new Error('Buyer HBAR journal not fully confirmed: STOP before TEUSD minting');
  }
  const expected=canonicalIntent({
    matchId,operation:'FUND_BUYER_HBAR',externalTradeId,
    signerAddress:requireAddress(operatorAddress,'funding operator'),
    targetAddress:requireAddress(buyerAddress,'buyer'),
    valueWei:'200000000000000000',callData:'0x',
  });
  if (row.payloadSha256!==expected.payloadSha256 ||
    row.signerAddress?.toLowerCase()!==expected.signerAddress ||
    row.targetAddress?.toLowerCase()!==expected.targetAddress ||
    !/^(0|[1-9]\d*)$/.test(String(row.nonce))) {
    throw new Error('Confirmed HBAR journal does not match this exact buyer and 0.2 HBAR transfer');
  }
  return expected;
}

export function confirmBuyerHbarOnChain(receipt,transaction,row,{buyerAddress,operatorAddress}) {
  if (!receipt || !transaction || receipt.status!==1 ||
    (receipt.hash??receipt.transactionHash)?.toLowerCase()!==row.txHash.toLowerCase() ||
    transaction.hash?.toLowerCase()!==row.txHash.toLowerCase() ||
    receipt.from?.toLowerCase()!==operatorAddress.toLowerCase() ||
    receipt.to?.toLowerCase()!==buyerAddress.toLowerCase() ||
    transaction.from?.toLowerCase()!==operatorAddress.toLowerCase() ||
    transaction.to?.toLowerCase()!==buyerAddress.toLowerCase() ||
    BigInt(transaction.value??-1)!==200000000000000000n ||
    transaction.data!=='0x' || BigInt(transaction.chainId??0)!==296n ||
    String(transaction.nonce)!==String(row.nonce) ||
    !Number.isInteger(receipt.blockNumber) || receipt.blockNumber<0) {
    throw new Error('Cannot independently verify confirmed 0.2 HBAR funding receipt and transaction');
  }
  return true;
}

export function disallowPrematureOperations(rows) {
  if (!Array.isArray(rows)) throw new Error('Journal rows missing');
  if (rows.some(r=>!['FUND_BUYER_HBAR','MINT_TEUSD'].includes(r.operation))) {
    throw new Error('Later operations already present: reconcile all intents before mint preparation');
  }
  const byOperation=new Set(rows.map(r=>r.operation));
  if (byOperation.size!==rows.length) throw new Error('Duplicate operation rows detected');
  return true;
}

export function prepareMintIntent({matchId,externalTradeId,adminAddress,tokenAddress,buyerAddress,
  amountMicrousd,buyerTeusdUnits,buyerHbarWei,adminHbarWei,adminHasMinterRole,tokenDecimals,
  tokenSymbol,chainId,matchStatus,escrowPaused,existingLocalTrade,existingOnChainId}) {
  if (chainId!==B14_CHAIN) throw new Error('Wrong Hedera chain ID');
  if (matchStatus!=='SELECTED') throw new Error('B12 match is not SELECTED');
  if (escrowPaused!==false) throw new Error('Escrow paused; do not create funding intents');
  if (existingLocalTrade) throw new Error('Existing PostgreSQL trade: manual reconciliation required');
  if (existingOnChainId!=='0') throw new Error('Existing on-chain trade: do not mint again');
  if (adminHasMinterRole!==true) throw new Error('Selected admin lacks TestEnergyUSD MINTER_ROLE');
  if (tokenDecimals!==6 || tokenSymbol!=='TEUSD') throw new Error('Token precision/symbol mismatch');
  const admin=requireAddress(adminAddress,'admin address');
  const token=requireAddress(tokenAddress,'token address');
  const buyer=requireAddress(buyerAddress,'buyer address');
  if (admin.toLowerCase()===buyer.toLowerCase() || token.toLowerCase()===buyer.toLowerCase()) {
    throw new Error('Mint recipient must be the distinct matched buyer wallet');
  }
  const amount=requireUint(amountMicrousd,'amountMicrousd',{positive:true});
  if (amount>MAX_PROTOTYPE_TEUSD_MICRO) throw new Error('B14 test-mint cap exceeded');
  if (requireUint(buyerTeusdUnits,'buyerTeusdUnits')!==0n) {
    throw new Error('Buyer already owns TEUSD: investigate before minting to prevent overfunding');
  }
  if (requireUint(buyerHbarWei,'buyerHbarWei')<REQUIRED_BUYER_HBAR_WEI) {
    throw new Error('Buyer needs at least 0.1 HBAR before TEUSD minting');
  }
  if (requireUint(adminHbarWei,'adminHbarWei')<REQUIRED_ADMIN_RESERVE_WEI) {
    throw new Error('Admin needs at least 1 HBAR reserve for future transaction fees');
  }
  const callData=exactMintCalldata(buyer,amount);
  return canonicalIntent({matchId,operation:'MINT_TEUSD',externalTradeId,
    signerAddress:admin,targetAddress:token,valueWei:'0',callData});
}

export function existingMintDisposition(existing,plan) {
  if (!existing) return 'CREATE';
  if (existing.externalTradeId?.toLowerCase()!==plan.externalTradeId) {
    throw new Error('Existing MINT_TEUSD external trade ID conflict');
  }
  compareImmutableIntent(existing,plan);
  return 'UNCHANGED';
}

export function displayTeusd(amountUnits) {
  const n=requireUint(amountUnits,'amountUnits',{positive:true});
  return `${n/1_000_000n}.${(n%1_000_000n).toString().padStart(6,'0')}`;
}
