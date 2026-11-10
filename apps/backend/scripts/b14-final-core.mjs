/** B14 final: pure safety policy shared by approval, create and escrow funding. */
import { canonicalIntent, compareImmutableIntent } from './b14-intent-journal-core.mjs';
import { requireUuid, requireAddress, requireUint, externalTradeId, tradeWindow, assertExistingChainMatches } from './b14-trade-core.mjs';

export const ORDER=Object.freeze(['APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE']);
export const ACTIVE=Object.freeze(['SIGNED','SUBMITTED','NEEDS_RECONCILIATION']);
export const ALL_OPS=Object.freeze(['FUND_BUYER_HBAR','MINT_TEUSD',...ORDER]);
export const GAS_LIMIT_CAP=600_000n;
export const MAX_TX_FEE_WEI=750_000_000_000_000_000n;
export const MAX_APPROVAL_FEE_WEI=160_000_000_000_000_000n;
export const MIN_BUYER_RESERVE_WEI=15_000_000_000_000_000n;
export const MIN_OPERATOR_RESERVE_WEI=1_000_000_000_000_000_000n;
const HASH=/^0x[0-9a-fA-F]{64}$/;
const DEC=/^(0|[1-9]\d*)$/;
const lower=(s)=>s?.toLowerCase();
function ensure(flag,msg){if(!flag)throw new Error(msg);}

export function argsForFinal(argv){
  const opts={}, required=['--match-id','--step'];
  for(let i=0;i<argv.length;i++){
    const name=argv[i];
    if(!['--step','--action','--match-id','--delivery-start'].includes(name)||Object.hasOwn(opts,name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Unknown, repeated or incomplete flag: ${name}`);
    opts[name]=argv[++i];
  }
  for(const name of required)ensure(opts[name],`Missing ${name}`);
  const step=opts['--step'].toUpperCase(), action=(opts['--action']||'PREVIEW').toUpperCase();
  ensure(ORDER.includes(step),'step must be approve_escrow, create_trade or fund_trade (underscore-separated)');
  ensure(['PREVIEW','STAGE','SEAL','SUBMIT','RECONCILE','STATUS'].includes(action),'action must be preview/stage/seal/submit/reconcile/status');
  if(step==='CREATE_TRADE')ensure(opts['--delivery-start'],'create_trade needs immutable --delivery-start UTC timestamp');
  if(step!=='CREATE_TRADE')ensure(!opts['--delivery-start'],'--delivery-start is only for CREATE_TRADE');
  return {matchId:requireUuid(opts['--match-id'],'match-id'),step,action,deliveryStart:opts['--delivery-start']??null};
}

export function validateConsent(action,env){
  const expected={STAGE:'B14_STAGE_EXACT_OPERATION',SEAL:'B14_SIGN_EXACT_OPERATION_NO_SEND',SUBMIT:'B14_SEND_EXACT_STORED_TESTNET_TX',RECONCILE:'B14_RECONCILE_ONLY'};
  if(expected[action])ensure(env.B14_FINAL_CONFIRM===expected[action],`B14_FINAL_CONFIRM must equal ${expected[action]}`);
}

export function approvedPlan({matchId,extId,buyer,token,escrow,amount}){
  const abiApprove='0x095ea7b3'+requireAddress(escrow,'escrow').slice(2).toLowerCase().padStart(64,'0')+requireUint(amount,'amount',{positive:true}).toString(16).padStart(64,'0');
  ensure(BigInt(amount)<=10_000_000n,'Prototype max 10 TEUSD approval');
  return canonicalIntent({matchId,operation:'APPROVE_ESCROW',externalTradeId:extId,signerAddress:buyer,targetAddress:token,valueWei:'0',callData:abiApprove});
}
export function createPlan({matchId,extId,operator,escrow,buyer,seller,quantity,price,window,iface}){
  const args=[extId,buyer,seller,requireUint(quantity,'quantity',{positive:true}),requireUint(price,'unitPrice',{positive:true}),BigInt(window.deliveryStart),BigInt(window.deliveryDeadline)];
  const callData=iface.encodeFunctionData('createTrade',args);
  return canonicalIntent({matchId,operation:'CREATE_TRADE',externalTradeId:extId,signerAddress:operator,targetAddress:escrow,valueWei:'0',callData,deliveryStart:window.deliveryStart,deliveryDeadline:window.deliveryDeadline});
}
export function fundPlan({matchId,extId,operator,escrow,tradeId,iface}){
  const id=requireUint(tradeId,'onChainTradeId',{positive:true});
  return canonicalIntent({matchId,operation:'FUND_TRADE',externalTradeId:extId,signerAddress:operator,targetAddress:escrow,valueWei:'0',callData:iface.encodeFunctionData('fundTrade',[id])});
}
export function checkJournal(row,plan,{allowExisting=true}={}){
  if(!row)return 'CREATE';
  ensure(allowExisting,'Operation intent already exists');
  ensure(lower(row.externalTradeId)===plan.externalTradeId,'Existing externalTradeId mismatch');
  if(row.status==='PLANNED')compareImmutableIntent(row,plan);
  else {
    ensure(row.matchId===plan.matchId&&row.operation===plan.operation&&row.chainId===296&&row.payloadSha256===plan.payloadSha256&&lower(row.signerAddress)===plan.signerAddress&&lower(row.targetAddress)===plan.targetAddress,'Immutable operation was modified');
  }
  return 'UNCHANGED';
}
export function checkSequence(rows,step,action){
  ensure(Array.isArray(rows),'Journal list missing');
  const by=new Map();
  for(const r of rows){ensure(ALL_OPS.includes(r.operation)&&!by.has(r.operation),'Unexpected or duplicated operation');by.set(r.operation,r);}
  ensure(by.get('FUND_BUYER_HBAR')?.status==='CONFIRMED'&&by.get('MINT_TEUSD')?.status==='CONFIRMED','HBAR funding and TEUSD mint must be CONFIRMED');
  const index=ORDER.indexOf(step);
  for(let j=0;j<index;j++)ensure(by.get(ORDER[j])?.status==='CONFIRMED',`${ORDER[j]} must be confirmed first`);
  for(let j=index+1;j<ORDER.length;j++)ensure(!by.has(ORDER[j]),`Later operation ${ORDER[j]} already journaled; reconcile instead`);
  if(!['RECONCILE','STATUS'].includes(action))ensure(!by.get(step)||by.get(step).status===({PREVIEW:'PLANNED',STAGE:'PLANNED',SEAL:'PLANNED',SUBMIT:'SIGNED'}[action]||'PLANNED'),`Existing ${step} status is not eligible for ${action}`);
  return by;
}
export function approvePrerequisites({balance,allowance,amount,hbar,tradeId,localTrade,escrowPaused}){
  ensure(!escrowPaused&&String(tradeId)==='0'&&!localTrade,'Trade exists or escrow paused');
  ensure(BigInt(balance)===BigInt(amount)&&BigInt(allowance)===0n,'Token balance must equal exact mint and allowance must start zero');
  ensure(BigInt(hbar)>=100_000_000_000_000_000n,'Buyer needs at least 0.1 HBAR before signing');
}
export function creationPrerequisites({balance,allowance,amount,tradeId,localTrade,escrowPaused,operatorHasRole}){
  ensure(!escrowPaused&&String(tradeId)==='0'&&!localTrade&&operatorHasRole,'Trade already exists, escrow paused or operator not authorized');
  ensure(BigInt(balance)===BigInt(amount)&&BigInt(allowance)===BigInt(amount),'Buyer TEUSD and exact escrow allowance required');
}
export function fundingPrerequisites({trade,expected,externalId,amount,balance,allowance,paused,operatorHasRole,nowSeconds}){
  ensure(!paused&&operatorHasRole,'Escrow paused or operator missing role');
  ensure(trade && trade.status==='CREATED','Trade must exist in CREATED status');
  assertExistingChainMatches(trade,expected,externalId);
  ensure(BigInt(trade.totalAmountMicrousd)===BigInt(amount),'Trade payment does not match B12');
  ensure(BigInt(trade.deliveryStart)>BigInt(nowSeconds)+60n,'Delivery start too close or already passed');
  ensure(BigInt(balance)>=BigInt(amount)&&BigInt(allowance)>=BigInt(amount),'Buyer has insufficient TEUSD or allowance');
}
export function checkedGasQuote({estimate,gasPrice,balance,step}){
  const e=BigInt(estimate),p=BigInt(gasPrice),b=BigInt(balance);
  ensure(e>0n&&p>0n,'Gas estimate or price invalid');
  const gasLimit=(e*120n+99n)/100n;
  const cap=step==='APPROVE_ESCROW'?MAX_APPROVAL_FEE_WEI:MAX_TX_FEE_WEI;
  const reserve=step==='APPROVE_ESCROW'?MIN_BUYER_RESERVE_WEI:MIN_OPERATOR_RESERVE_WEI;
  const maxFee=gasLimit*p;
  ensure(gasLimit<=GAS_LIMIT_CAP&&maxFee<=cap,'Gas quote exceeds capped B14 limit');
  ensure(b>=maxFee+reserve,'Insufficient signer balance with reserve');
  return {gasLimit,gasPrice:p,maxFee};
}
export function verifySignedEnvelope(tx,plan,row){
  ensure(tx?.signature&&tx.hash&&tx.hash.toLowerCase()===lower(row.txHash),'Stored signature or hash mismatch');
  ensure(lower(tx.from)===plan.signerAddress&&lower(tx.to)===plan.targetAddress,'Signed sender/recipient mismatch');
  ensure(BigInt(tx.chainId)===296n&&tx.type===0&&BigInt(tx.value)===0n,'Signed chain/type/value mismatch');
  ensure(lower(tx.data||'0x')===plan.callData&&String(tx.nonce)===String(row.nonce),'Signed calldata or nonce mismatch');
  ensure(BigInt(tx.gasLimit)>0n&&BigInt(tx.gasLimit)<=GAS_LIMIT_CAP&&BigInt(tx.gasPrice)>0n,'Invalid signed gas');
  ensure(BigInt(tx.gasLimit)*BigInt(tx.gasPrice)<=(plan.operation==='APPROVE_ESCROW'?MAX_APPROVAL_FEE_WEI:MAX_TX_FEE_WEI),'Signed maximum gas fee too large');
}
export function receiptKind(receipt,tx,plan,hash){
  if(receipt){
    ensure(lower(receipt.hash??receipt.transactionHash)===lower(hash)&&lower(receipt.from)===plan.signerAddress&&lower(receipt.to)===plan.targetAddress,'Receipt does not match journal');
    ensure(Number.isInteger(receipt.blockNumber)&&[0,1].includes(receipt.status),'Invalid receipt block/status');
  }
  if(tx)ensure(lower(tx.hash)===lower(hash)&&lower(tx.from)===plan.signerAddress&&lower(tx.to)===plan.targetAddress&&lower(tx.data||'0x')===plan.callData,'RPC transaction differs from signed call');
  if(receipt)return receipt.status===1?'CONFIRMED':'REVERTED';
  return tx?'PENDING':'UNKNOWN';
}
export function receiptEffect(step,{receipt,events,plan,terms,token,escrow,chainId,onChainTrade,buyerBalance,allowance,escrowTokenBalance}){
  const same=(a,b)=>lower(String(a))===lower(String(b));
  if(step==='APPROVE_ESCROW'){
    ensure(events.filter(e=>e.contract==='TestEnergyUSD'&&e.event==='Approval'&&same(e.args.owner,terms.buyer)&&same(e.args.spender,escrow)&&String(e.args.value)===String(terms.totalAmountMicrousd)).length===1,'Exactly one Approval event is required');
    ensure(BigInt(allowance)===BigInt(terms.totalAmountMicrousd),'Escrow allowance does not match confirmed approval');
  } else if(step==='CREATE_TRADE'){
    ensure(onChainTrade&&onChainTrade.status==='CREATED','Created trade missing or wrong on-chain status');
    assertExistingChainMatches(onChainTrade,terms,plan.externalTradeId);
    ensure(BigInt(onChainTrade.deliveryStart)===BigInt(plan.deliveryStart)&&BigInt(onChainTrade.deliveryDeadline)===BigInt(plan.deliveryDeadline),'On-chain delivery window differs from signed intent');
    ensure(events.filter(e=>e.contract==='EnergyTradingEscrow'&&e.event==='TradeCreated'&&same(e.args.externalTradeId,plan.externalTradeId)&&same(e.args.buyer,terms.buyer)&&same(e.args.seller,terms.seller)&&String(e.args.onChainTradeId)===String(onChainTrade.onChainTradeId)).length===1,'Exactly one matching TradeCreated event required');
  } else if(step==='FUND_TRADE'){
    ensure(onChainTrade?.status==='AWAITING_DELIVERY','Escrow status must be AWAITING_DELIVERY');
    ensure(events.filter(e=>e.contract==='EnergyTradingEscrow'&&e.event==='TradeFunded'&&String(e.args.onChainTradeId)===String(onChainTrade.onChainTradeId)&&String(e.args.amount)===String(terms.totalAmountMicrousd)).length===1,'Exactly one TradeFunded event required');
    ensure(events.filter(e=>e.contract==='TestEnergyUSD'&&e.event==='Transfer'&&same(e.args.from,terms.buyer)&&same(e.args.to,escrow)&&String(e.args.value)===String(terms.totalAmountMicrousd)).length===1,'Exactly one buyer-to-escrow TEUSD Transfer required');
    ensure(BigInt(escrowTokenBalance)>=BigInt(terms.totalAmountMicrousd),'Escrow must hold trade payment');
    ensure(BigInt(buyerBalance)===0n,'Buyer balance should be zero after exact escrow funding');
  }
  return true;
}
export function requireReadyForSubmit({row,plan,nonceLatest,noncePending,chainKnown,otherPending}){
  ensure(row?.status==='SIGNED','Only SIGNED intent may submit');
  ensure(!chainKnown&&Number(nonceLatest)===Number(row.nonce)&&Number(noncePending)===Number(row.nonce),'Nonce or chain state uncertain: reconcile first');
  ensure(!otherPending,'Another unresolved intent exists for this signer');
  return true;
}
