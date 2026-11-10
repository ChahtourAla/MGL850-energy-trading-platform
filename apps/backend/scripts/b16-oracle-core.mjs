/** B16 pure oracle safety checks: no RPC, filesystem, signing, or DB side effects. */
import { createHash } from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^0x[0-9a-f]{64}$/i, ADDRESS=/^0x[0-9a-f]{40}$/i;
const UNSIGNED=/^(0|[1-9]\d*)$/;
export const STATES=['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'];
export const GAS_LIMIT_CAP=600_000n;
export const MAX_FEE_WEI=750_000_000_000_000_000n;
export const ORACLE_RESERVE_WEI=200_000_000_000_000_000n;
const low=x=>String(x).toLowerCase();
export function requireB16(ok,message){if(!ok)throw new Error(message);}
export function unsigned(x,name,positive=false){
  const value=typeof x==='bigint'?x.toString():typeof x==='number'&&Number.isSafeInteger(x)?String(x):x;
  requireB16(typeof value==='string'&&UNSIGNED.test(value)&&value.length<=78,`${name} must be canonical unsigned integer`);
  const b=BigInt(value);requireB16(b<=(1n<<256n)-1n&&(!positive||b>0n),`${name} is out of range`);return b;
}
export function utc(input){
  requireB16(typeof input==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input),'Invalid UTC timestamp');
  const d=new Date(input);requireB16(Number.isFinite(d.getTime())&&d.toISOString().replace('.000Z','Z')===input.replace('.000Z','Z'),'Invalid canonical UTC timestamp');
  return d;
}
export function argsB16(argv){
 const allowed=new Set(['--match-id','--action','--evidence','--output','--delivered-wh']);const opt={};
 for(let i=0;i<argv.length;i++){const k=argv[i];requireB16(allowed.has(k)&&!Object.hasOwn(opt,k)&&argv[i+1]&&!argv[i+1].startsWith('--'),`Unknown, duplicate or missing B16 option: ${k}`);opt[k]=argv[++i];}
 requireB16(UUID.test(opt['--match-id']??''),'--match-id UUID required');
 const action=opt['--action']??'preflight';requireB16(['preflight','simulate','execute','reconcile','sync','verify'].includes(action),'Unsupported B16 action');
 if(action==='simulate')requireB16(opt['--output']&&!opt['--evidence'],'simulate needs --output and not --evidence');
 else requireB16(!opt['--output']&&!opt['--delivered-wh'],'--output/--delivered-wh allowed only for simulate');
 if(action==='execute')requireB16(Boolean(opt['--evidence']),'execute requires --evidence path');
 else requireB16(!opt['--evidence'],'--evidence allowed only for execute');
 if(opt['--delivered-wh'])unsigned(opt['--delivered-wh'],'delivered-wh',true);
 return {matchId:low(opt['--match-id']),action,evidence:opt['--evidence']??null,output:opt['--output']??null,deliveredWh:opt['--delivered-wh']??null};
}
export function validateWindow(nowSeconds,start,deadline,{fresh=false,clockSkewSeconds=15}={}){
 const n=unsigned(nowSeconds,'now'),s=unsigned(start,'deliveryStart',true),d=unsigned(deadline,'deliveryDeadline',true);
 requireB16(s<d,'Delivery window invalid');
 const inWindow=n>=s&&n<=d;
 if(fresh)requireB16(inWindow,`Oracle confirmation is allowed only inside delivery window`);
 return {inWindow,start:s,deadline:d,now:n,clockSkewSeconds};
}
/** Choose between actual-trade evidence and an isolated simulator-only dry run.
 * An out-of-window dry run has a synthetic window centred on now. It must never
 * yield an evidence file usable by execute() for the real funded trade. */
export function simulationPlan(nowSeconds,start,deadline){
 const w=validateWindow(nowSeconds,start,deadline);
 if(w.inWindow)return {mode:'LIVE_EVIDENCE',start:w.start,deadline:w.deadline};
 requireB16(w.now>=3600n,'Clock is invalid for isolated simulation');
 return {mode:'ISOLATED_DRY_RUN',start:w.now-1800n,deadline:w.now+1800n};
}
export function validateDelivery(record,context,nowSeconds){
 requireB16(record&&typeof record==='object'&&!Array.isArray(record),'DeliveryRecord must be JSON object');
 const allowed=['deliveryId','tradeId','onChainTradeId','sellerId','buyerId','expectedWh','deliveredWh','timeSlot','status','evidenceHash'];
 requireB16(Object.keys(record).every(k=>allowed.includes(k)),'Unexpected DeliveryRecord field');
 const req=allowed.filter(k=>k!=='evidenceHash');requireB16(req.every(k=>Object.hasOwn(record,k)),'DeliveryRecord missing required field');
 for(const k of ['deliveryId','tradeId','sellerId','buyerId'])requireB16(UUID.test(record[k]),`${k} must be UUID`);
 requireB16(record.status==='SUCCESS','Only SUCCESS delivery may trigger oracle settlement');
 requireB16(low(record.tradeId)===low(context.tradeId)&&low(record.sellerId)===low(context.sellerId)&&low(record.buyerId)===low(context.buyerId),'Delivery parties or backend trade UUID mismatch');
 requireB16(String(record.onChainTradeId)===String(context.onChainTradeId)&&Number.isSafeInteger(record.onChainTradeId),'Delivery on-chain trade ID mismatch');
 const expected=unsigned(record.expectedWh,'expectedWh',true),delivered=unsigned(record.deliveredWh,'deliveredWh',true);
 requireB16(expected===unsigned(context.expectedWh,'matched quantity',true),'Expected energy does not match funded trade');
 requireB16(delivered>=expected,'Insufficient delivered energy');
 requireB16(delivered<=expected+expected/10n,'Delivered energy cannot exceed expected by >10%');
 const ts=BigInt(Math.floor(utc(record.timeSlot).getTime()/1000));
 const window=validateWindow(nowSeconds,context.deliveryStart,context.deliveryDeadline,{fresh:true});
 requireB16(ts>=window.start&&ts<=window.deadline,'Delivery evidence timestamp outside actual on-chain window');
 requireB16(ts<=window.now+15n,'Future-dated delivery evidence rejected');
 requireB16(window.now<=ts+300n,'Delivery evidence stale (>5 minutes)');
 requireB16(!Object.hasOwn(record,'evidenceHash'),'Simulator must not self-attest an oracle evidenceHash');
 return {expectedWh:expected.toString(),deliveredWh:delivered.toString(),evidenceSeconds:ts.toString()};
}
export function evidenceCommitment(record,context){
 const payload={domain:'mgl850:b16:simulated-delivery:v1',chainId:296,escrow:low(context.escrow),externalTradeId:low(context.externalTradeId),
   matchId:low(context.matchId),deliveryId:low(record.deliveryId),tradeId:low(record.tradeId),onChainTradeId:String(record.onChainTradeId),
   sellerId:low(record.sellerId),buyerId:low(record.buyerId),expectedWh:String(record.expectedWh),deliveredWh:String(record.deliveredWh),
   timeSlot:record.timeSlot,status:record.status};
 return '0x'+createHash('sha256').update(JSON.stringify(payload),'utf8').digest('hex');
}
export function checkPrerequisites({chain,trade,dbTrade,match,journal,onChainId,expectedExternalId,oracleHasRole,escrowPaused,nowSeconds,escrowBalance}){
 requireB16(chain===296&&!escrowPaused&&oracleHasRole,'Wrong chain, escrow paused or Oracle role absent');
 requireB16(match?.status==='SELECTED','Match must be SELECTED');
 requireB16(Array.isArray(journal)&&journal.length===5,'Exactly five original B14 operations required');
 const expected=['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'];
 requireB16(expected.every(k=>journal.filter(x=>x.operation===k&&x.status==='CONFIRMED'&&HASH.test(x.txHash??'')).length===1),'B14 funding journal incomplete');
 requireB16(unsigned(onChainId,'onChainId',true)>0n,'On-chain ID required');
 requireB16(trade?.status==='AWAITING_DELIVERY'&&trade.statusCode===2&&low(trade.externalTradeId)===low(expectedExternalId),'On-chain trade not funded or external ID mismatch');
 requireB16(dbTrade?.status==='AWAITING_DELIVERY'&&String(dbTrade.onChainTradeId)===String(onChainId),'B15 PostgreSQL Trade must be funded and synchronized');
 requireB16(unsigned(escrowBalance,'escrowBalance')>=unsigned(trade.totalAmountMicrousd,'payment',true),'Escrow token balance insufficient');
 return validateWindow(nowSeconds,trade.deliveryStart,trade.deliveryDeadline);
}
export function feeQuote({estimate,gasPrice,balance}){
 const e=unsigned(estimate,'estimate',true),p=unsigned(gasPrice,'gasPrice',true),b=unsigned(balance,'oracle HBAR');
 const gasLimit=(e*120n+99n)/100n,cost=gasLimit*p;
 requireB16(gasLimit<=GAS_LIMIT_CAP&&cost<=MAX_FEE_WEI,'Oracle gas quote exceeds cap');
 requireB16(b>=cost+ORACLE_RESERVE_WEI,'Oracle lacks HBAR fee + reserve');
 return {gasLimit,gasPrice:p,maxFee:cost};
}
export function transitions(before,after){
 const allowed={PLANNED:['SIGNED'],SIGNED:['SUBMITTED','CONFIRMED','REVERTED'],SUBMITTED:['CONFIRMED','REVERTED','NEEDS_RECONCILIATION'],NEEDS_RECONCILIATION:['CONFIRMED','REVERTED'],CONFIRMED:[],REVERTED:[]};
 requireB16(allowed[before]?.includes(after),`Unsafe B16 journal transition ${before}->${after}`);return true;
}
export function receiptResult({row,receipt,transaction,oracle,escrow,calldata}){
 requireB16(row?.txHash&&row.nonce!==null,'Stored journal has no signed transaction reference');
 if(transaction){requireB16(low(transaction.hash)===low(row.txHash)&&low(transaction.from)===low(oracle)&&low(transaction.to)===low(escrow)&&low(transaction.data)===low(calldata)&&String(transaction.nonce)===String(row.nonce)&&String(transaction.chainId)==='296','Oracle transaction does not match immutable intent');}
 if(!receipt)return transaction?'PENDING':'UNKNOWN';
 requireB16(low(receipt.hash??receipt.transactionHash)===low(row.txHash)&&low(receipt.from)===low(oracle)&&low(receipt.to)===low(escrow),'Oracle receipt differs from signed intent');
 requireB16(receipt.status===1||receipt.status===0,'Oracle receipt missing success status');
 return receipt.status===1?'CONFIRMED':'REVERTED';
}
export function verifySettlement({events,trade,proof,onChainId,seller,escrow,token,amount}){
 const is=(e,contract,event,predicate)=>e.contract===contract&&e.event===event&&predicate(e.args??{});
 const matches=(a,b)=>low(a)===low(b);
 const delivery=events.filter(e=>is(e,'EnergyTradingEscrow','DeliveryConfirmed',a=>String(a.onChainTradeId)===String(onChainId)&&String(a.deliveredWh)===String(proof.deliveredWh)&&matches(a.evidenceHash,proof.evidenceHash)));
 const settled=events.filter(e=>is(e,'EnergyTradingEscrow','TradeSettled',a=>String(a.onChainTradeId)===String(onChainId)&&matches(a.seller,seller)&&String(a.amount)===String(amount)));
 const transfer=events.filter(e=>is(e,'TestEnergyUSD','Transfer',a=>matches(a.from,escrow)&&matches(a.to,seller)&&String(a.value)===String(amount)));
 requireB16(delivery.length===1&&settled.length===1&&transfer.length===1,'Missing/duplicate matching DeliveryConfirmed, TradeSettled or TEUSD Transfer');
 requireB16(trade?.status==='COMPLETED'&&trade.statusCode===4,'On-chain trade must be COMPLETED');
 requireB16(String(trade.deliveredWh)===String(proof.deliveredWh)&&matches(trade.evidenceHash,proof.evidenceHash),'Recorded delivery amount/hash differs from evidence');
 return true;
}
export function safeDbProjection(fields,source){
 // Apply only matching model fields; never fabricate unsupported mandatory fields.
 const scalar=new Set(['String','Int','BigInt','DateTime','Decimal','Boolean','Json']);const data={};
 for(const [name,f] of fields){
  if(f.list||f.relation)continue;
  const value=source[name];
  if(value===undefined){requireB16(!f.required,`Required DeliveryRecord.${name} not supported`);continue;}
  if(!scalar.has(f.type)&&!(name==='status'&&!f.relation))continue;
  if(f.type==='Int')requireB16(Number.isSafeInteger(Number(value))&&Number(value)>=-2147483648&&Number(value)<=2147483647,`${name} exceeds int32`);
  data[name]=f.type==='DateTime'?new Date(value):f.type==='BigInt'?BigInt(value):f.type==='Int'?Number(value):(['String','Decimal'].includes(f.type)||name==='status')?String(value):value;
 }
 requireB16(Object.keys(data).some(x=>x==='tradeId'),'DeliveryRecord requires backend trade link');
 requireB16(['deliveredWh','evidenceHash','status','timeSlot','expectedWh'].every(x=>Object.hasOwn(data,x)),'DeliveryRecord must capture evidence, timestamps, status and quantities');
 return data;
}
export function parseModel(source,name){
 const match=source.match(new RegExp('(?:^|\\n)model\\s+'+name+'\\s*\\{([\\s\\S]*?)^\\}','m'));
 requireB16(match,`Prisma schema missing model ${name}`);const fields=new Map();
 for(const raw of match[1].split(/\r?\n/)){
  const line=raw.replace(/\/\/.*$/,'').trim();if(!line||line.startsWith('@@')||line.startsWith('//'))continue;
  const x=line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
  requireB16(x,`Unrecognized ${name} field declaration`);let [_,field,type,suffix,attrs]=x;
  const rel=/@relation\(/.test(attrs)||suffix==='[]'||(field!=='status'&&!['String','Int','BigInt','DateTime','Decimal','Boolean','Json','Bytes','Float'].includes(type));
  fields.set(field,{type,list:suffix==='[]',relation:rel,required:!suffix&&!rel&&!/@default\(|@updatedAt\b/.test(attrs),attrs});
 }
 return fields;
}
