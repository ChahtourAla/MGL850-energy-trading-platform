/** Pure B17 state machine and transaction/receipt assertions. No DB, network or signer access. */
import { createHash } from 'node:crypto';

export const B17_OPS = Object.freeze({
  CANCEL: Object.freeze({ method: 'cancelTrade', pre: 'CREATED', post: 'CANCELLED', code: 5, event: 'TradeCancelled' }),
  EXPIRE: Object.freeze({ method: 'expireTrade', pre: 'AWAITING_DELIVERY', post: 'EXPIRED', code: 6, event: 'TradeExpired' }),
  REFUND: Object.freeze({ method: 'refundTrade', pre: 'EXPIRED', post: 'REFUNDED', code: 8, event: 'TradeRefunded' }),
});
export const B17_STATES = ['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'];
export const PROTECTED_ID = '2';
export const MAX_GAS_LIMIT = 500_000n;
export const MAX_TX_COST = 750_000_000_000_000_000n; // 0.75 HBAR (18 decimals on JSON-RPC)
export const FEE_RESERVE = 200_000_000_000_000_000n;
// RFC 4122 variant in fourth group must begin 8, 9, a or b; allow all UUID versions actually stored by Prisma.
const DB_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32=/^0x[0-9a-f]{64}$/i;
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const INTEGER=/^(0|[1-9][0-9]*)$/;
const lower=x=>String(x).toLowerCase();
export const digest=x=>createHash('sha256').update(x).digest('hex');
export function assertB17(value,message){if(!value)throw new Error(message)}
export function uint(x,label,positive=false){
 const s=typeof x==='bigint'?x.toString():typeof x==='number'&&Number.isSafeInteger(x)?String(x):x;
 assertB17(typeof s==='string'&&INTEGER.test(s)&&s.length<=78,`${label}: not a canonical unsigned integer`);
 const value=BigInt(s);assertB17(value<=((1n<<256n)-1n)&&(!positive||value>0n),`${label}: out of range`);return value;
}
export function argsB17(argv){
 const options={};const keys=new Set(['--match-id','--action','--operation']);
 for(let i=0;i<argv.length;i++){
  const k=argv[i];assertB17(keys.has(k)&&!Object.hasOwn(options,k)&&argv[i+1]&&!argv[i+1].startsWith('--'),`Unknown/duplicate/missing option ${k}`);options[k]=argv[++i];
 }
 assertB17(DB_UUID.test(options['--match-id']??''),'--match-id requires a UUID');
 const action=options['--action']??'inspect';const operation=(options['--operation']??'').toUpperCase();
 assertB17(['inspect','plan','execute','reconcile','sync','verify'].includes(action),'Unsupported B17 action');
 if(action==='inspect')assertB17(!operation,'inspect does not select an operation');
 else assertB17(Object.hasOwn(B17_OPS,operation)||(['inspect','verify'].includes(action)&&operation==='SETTLEMENT'),'--operation must be cancel, expire, refund (or settlement for verify)');
 return {action,operation,matchId:lower(options['--match-id'])};
}
export function transition(from,to){
 const transitions={PLANNED:['SIGNED'],SIGNED:['SUBMITTED'],SUBMITTED:['NEEDS_RECONCILIATION','CONFIRMED','REVERTED'],NEEDS_RECONCILIATION:['CONFIRMED','REVERTED'],CONFIRMED:[],REVERTED:[]};
 assertB17(transitions[from]?.includes(to),`Unsafe B17 state change ${from}->${to}`);return true;
}
export function protectedWrite(id,operation,confirmation){
 assertB17(!(String(id)===PROTECTED_ID&&confirmation!=='I_ACCEPT_B17_OPERATION_ON_RESERVED_TRADE_2'),
  'Trade #2 is reserved for B16. Read-only allowed; B17 writes require separate protected-trade consent');
 assertB17(Object.hasOwn(B17_OPS,operation),'Unknown operator write');return true;
}
export function eligibility({operation,trade,dbTrade,chainNow,paused,operatorHasRole,escrowBalance,b16Journal,expireJournal}){
 const rule=B17_OPS[operation];assertB17(rule,'Unsupported lifecycle transition');
 assertB17(!paused&&operatorHasRole===true,'Contract paused or signer lacks OPERATOR_ROLE');
 assertB17(trade?.status===rule.pre,`On-chain status must be ${rule.pre} for ${operation}`);
 assertB17(uint(trade.statusCode,'statusCode')===BigInt(operation==='CANCEL'?0:operation==='EXPIRE'?2:6),'On-chain status numeric value mismatch');
 assertB17(!b16Journal||b16Journal.status==='REVERTED','Existing B16 oracle journal could settle the same trade; resolve it first');
 const total=uint(trade.totalAmountMicrousd,'totalAmount',true);
 if(operation==='EXPIRE'){
  assertB17(dbTrade?.status==='AWAITING_DELIVERY','B15 Trade must be AWAITING_DELIVERY');
  // Solidity requires block.timestamp > deadline. Extra 60s to avoid an RPC stale-block race.
  assertB17(uint(chainNow,'latest block timestamp')>uint(trade.deliveryDeadline,'deadline')+60n,'On-chain deadline not sufficiently passed (>60s buffer)');
  assertB17(uint(escrowBalance,'escrow balance')>=total,'Escrow balance insufficient for this funded trade');
 }
 if(operation==='REFUND'){
  assertB17(dbTrade?.status==='EXPIRED','Persist and verify EXPIRED in PostgreSQL before refund');
  assertB17(expireJournal?.status==='CONFIRMED'&&expireJournal?.syncedAt,'Prior B17 EXPIRE intent must be reconciled and synced');
  assertB17(uint(escrowBalance,'escrow balance')>=total,'Not enough escrow tokens to refund');
 }
 if(operation==='CANCEL'){
  assertB17(!dbTrade||dbTrade.status==='CREATED','Cannot cancel a DB trade already funded or terminal');
 }
 return {from:rule.pre,to:rule.post,total:total.toString()};
}
export function quote({estimate,gasPrice,balance}){
 const gas=(uint(estimate,'gas estimate',true)*120n+99n)/100n;
 const price=uint(gasPrice,'gas price',true),available=uint(balance,'operator balance');
 assertB17(gas<=MAX_GAS_LIMIT&&gas*price<=MAX_TX_COST,'Gas estimate or maximum fee exceeds cap');
 assertB17(available>=gas*price+FEE_RESERVE,'Operator needs HBAR for gas plus reserve');
 return {gasLimit:gas,gasPrice:price};
}
export function sameImmutableIntent(row,expected){
 assertB17(row&&row.operation===expected.operation&&lower(row.externalTradeId)===lower(expected.externalTradeId)&&
  String(row.onChainTradeId)===String(expected.onChainTradeId)&&lower(row.signerAddress)===lower(expected.signerAddress)&&
  lower(row.targetAddress)===lower(expected.targetAddress)&&row.callDataSha256===expected.callDataSha256&&Number(row.chainId)===296&&
  String(row.totalAmountMicrousd)===String(expected.totalAmountMicrousd),'Existing B17 intent does not match immutable planned operation');
 return true;
}
export function signedMatches(signed,row,plan){
 assertB17(signed&&lower(signed.hash)===lower(row.txHash)&&lower(signed.from)===lower(plan.signerAddress)&&lower(signed.to)===lower(plan.targetAddress)&&
  lower(signed.data)===lower(plan.callData)&&String(signed.nonce)===String(row.nonce)&&String(signed.chainId)==='296'&&
  uint(signed.value,'native tx amount')===0n,'Stored signed B17 transaction mismatched immutable plan');return true;
}
export function receiptDisposition({row,tx,receipt,plan}){
 assertB17(row?.txHash&&row.nonce!==null&&row.nonce!==undefined,'Journal is missing signed transaction identity');
 if(tx)signedMatches(tx,row,plan);
 if(!receipt)return tx?'PENDING':'UNKNOWN';
 assertB17(lower(receipt.hash??receipt.transactionHash)===lower(row.txHash)&&lower(receipt.from)===lower(plan.signerAddress)&&
  lower(receipt.to)===lower(plan.targetAddress),'Receipt does not match signed journal intent');
 assertB17(receipt.status===0||receipt.status===1,'Receipt lacks status');return receipt.status===1?'CONFIRMED':'REVERTED';
}
export function verifyOperatorEffects({operation,events,trade,plan,token,escrow}){
 const rule=B17_OPS[operation];assertB17(rule,'Unknown operation');
 assertB17(trade?.status===rule.post&&uint(trade.statusCode,'post status')===BigInt(rule.code),'Post-transaction trade status mismatch');
 const relevant=(events??[]).filter(e=>e.contract==='EnergyTradingEscrow'&&['TradeCancelled','TradeExpired','TradeRefunded','TradeSettled','DeliveryConfirmed'].includes(e.event));
 assertB17(relevant.length===1&&relevant[0].event===rule.event&&String(relevant[0].args.onChainTradeId)===String(plan.onChainTradeId),
  `Expected only one ${rule.event} for correct on-chain trade ID`);
 const transfers=(events??[]).filter(e=>e.contract==='TestEnergyUSD'&&e.event==='Transfer');
 if(operation==='REFUND'){
  assertB17(lower(relevant[0].args.buyer)===lower(plan.buyer)&&String(relevant[0].args.amount)===String(plan.totalAmountMicrousd),
   'TradeRefunded recipient/amount mismatch');
  assertB17(transfers.length===1&&lower(transfers[0].args.from)===lower(escrow)&&lower(transfers[0].args.to)===lower(plan.buyer)&&
   String(transfers[0].args.value)===String(plan.totalAmountMicrousd),'Buyer did not receive exact TEUSD refund');
 }else assertB17(transfers.length===0,'CANCEL/EXPIRE must not emit ERC20 Transfer');
 return true;
}
export function statusDbChange(operation,current){
 const allowed={CANCEL:[null,'CREATED','CANCELLED'],EXPIRE:['AWAITING_DELIVERY','EXPIRED'],REFUND:['EXPIRED','REFUNDED']};
 const next=B17_OPS[operation]?.post;assertB17(next,'Invalid B17 operation');
 assertB17(allowed[operation].includes(current??null),`Unsafe Prisma Trade state ${current} for ${operation}`);
 return current===next?'UNCHANGED':current===null?'NO_TRADE_ROW':'UPDATE';
}
export function assertAddresses(buyer,seller,operator,target){
 assertB17([buyer,seller,operator,target].every(x=>ADDRESS.test(x??'')),'Noncanonical EVM address');
 assertB17(lower(buyer)!==lower(seller),'Buyer/seller identical');return true;
}
export function assertEvidenceId(x){assertB17(HEX32.test(x??''),'Expected bytes32');return true;}
