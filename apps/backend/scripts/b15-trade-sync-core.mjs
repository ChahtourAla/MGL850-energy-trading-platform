/** B15: pure trade-projection checks. No RPC, database, signer or secret access. */
import { createHash } from 'node:crypto';

export const B15_OPERATIONS = Object.freeze(['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE']);
export const B15_STATUS = 'AWAITING_DELIVERY';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DEC = /^(0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lower = (x) => String(x).toLowerCase();
export function requireB15(condition, message) { if(!condition) throw new Error(message); }
export function strictUnsigned(x, label, positive=false) {
  const s = typeof x==='bigint'?x.toString():String(x);
  requireB15(DEC.test(s) && s.length<=78, `${label} must be canonical unsigned integer`);
  const n=BigInt(s);requireB15(n<=(1n<<256n)-1n && (!positive||n>0n),`${label} out of bounds`);
  return n;
}
export function b15Args(argv) {
  const out={action:'preview',matchId:null};
  const seen=new Set();
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];requireB15(!seen.has(arg),`Repeated B15 flag ${arg}`);seen.add(arg);
    if(arg==='--sync'||arg==='--verify') {requireB15(out.action==='preview','Only one B15 action allowed');out.action=arg.slice(2);}
    else if(arg==='--match-id') {requireB15(i+1<argv.length && !argv[i+1].startsWith('--'),'Missing --match-id');out.matchId=argv[++i];}
    else throw new Error(`Unknown B15 argument: ${arg}`);
  }
  requireB15(typeof out.matchId==='string'&&UUID.test(out.matchId),'--match-id must be a UUID');
  out.matchId=out.matchId.toLowerCase();return out;
}
export function validateB15Journal(rows, {matchId,externalId,buyer,operator,token,escrow,admin}) {
  requireB15(Array.isArray(rows)&&rows.length===5,'B14 journal must have exactly five records');
  const by=new Map();
  for(const row of rows) {
    requireB15(B15_OPERATIONS.includes(row.operation)&&!by.has(row.operation),'Unexpected or duplicated B14 journal operation');
    by.set(row.operation,row);
    requireB15(row.matchId===matchId&&row.chainId===296&&lower(row.externalTradeId)===lower(externalId),'Journal provenance/chain mismatch');
    requireB15(row.status==='CONFIRMED'&&row.confirmedAt instanceof Date&&!Number.isNaN(row.confirmedAt.getTime()),'All five B14 operations must be confirmed');
    requireB15(HASH.test(row.txHash??'')&&typeof row.payloadSha256==='string'&&/^[0-9a-f]{64}$/.test(row.payloadSha256),'Missing transaction hash or immutable digest');
    requireB15(typeof row.nonce==='string'&&DEC.test(row.nonce),'Confirmed operation nonce missing');
  }
  const expected={
    FUND_BUYER_HBAR:[operator,buyer],MINT_TEUSD:[admin,token],APPROVE_ESCROW:[buyer,token],
    CREATE_TRADE:[operator,escrow],FUND_TRADE:[operator,escrow],
  };
  for(const [op,[signer,target]] of Object.entries(expected)) {
    const row=by.get(op);requireB15(ADDR.test(row.signerAddress??'')&&ADDR.test(row.targetAddress??''),'Invalid signer/target in B14 journal');
    requireB15(lower(row.signerAddress)===lower(signer)&&lower(row.targetAddress)===lower(target),`${op} signer/target mismatch`);
  }
  const hashes=new Set(rows.map(row=>lower(row.txHash)));
  requireB15(hashes.size===5,'Two journal operations share a transaction hash');
  return by;
}
export function validateB15Trade(trade,{externalId,terms,onChainId}) {
  requireB15(trade&&String(onChainId)!=='0'&&strictUnsigned(onChainId,'onChainId',true)>0n,'Trade not found on chain');
  requireB15(trade.status===B15_STATUS&&trade.statusCode===2,'Trade is not AWAITING_DELIVERY');
  requireB15(lower(trade.externalTradeId)===lower(externalId),'On-chain external ID mismatch');
  requireB15(lower(trade.buyer)===lower(terms.buyer)&&lower(trade.seller)===lower(terms.seller),'On-chain buyer/seller mismatch');
  for(const [name,field] of [['quantityWh','quantityWh'],['unitPriceMicrousdPerKwh','unitPriceMicrousdPerKwh'],['totalAmountMicrousd','totalAmountMicrousd']]) {
    requireB15(strictUnsigned(trade[name],name,true)===strictUnsigned(terms[field],field,true),`On-chain ${name} mismatch`);
  }
  const start=strictUnsigned(trade.deliveryStart,'deliveryStart',true), end=strictUnsigned(trade.deliveryDeadline,'deliveryDeadline',true);
  requireB15(end>start&&end-start===3600n,'Unexpected trade delivery window');
  requireB15(strictUnsigned(trade.deliveredWh,'deliveredWh')===0n,'Trade delivery has already started; use later lifecycle synchronizer');
  return {onChainTradeId:String(onChainId),deliveryStart:new Date(Number(start)*1000),deliveryDeadline:new Date(Number(end)*1000)};
}
const matchingEvents=(events,contract,event,predicate)=>events.filter(x=>x.contract===contract&&x.event===event&&predicate(x.args??{}));
export function validateB15Receipts({receipts,eventsByOperation,journals,terms,externalId,onChainId,token,escrow,admin,operator}) {
  const matches=(a,b)=>lower(a)===lower(b); const amount=String(terms.totalAmountMicrousd);
  for(const op of B15_OPERATIONS) {
    const receipt=receipts[op],row=journals.get(op);
    requireB15(receipt&&receipt.status===1&&matches(receipt.hash??receipt.transactionHash,row.txHash)&&Number.isInteger(receipt.blockNumber)&&receipt.blockNumber>=0,`${op} missing successful matching receipt`);
    requireB15(matches(receipt.from,row.signerAddress)&&matches(receipt.to,row.targetAddress),`${op} receipt sender/target mismatch`);
    requireB15(Array.isArray(eventsByOperation[op]),`${op} event parsing missing`);
  }
  const hbarTx=receipts.FUND_BUYER_HBAR.transaction;
  requireB15(hbarTx&&matches(hbarTx.from,operator)&&matches(hbarTx.to,terms.buyer)&&lower(hbarTx.hash)===lower(journals.get('FUND_BUYER_HBAR').txHash),'HBAR top-up transaction mismatched');
  const hbarValue=strictUnsigned(hbarTx.value,'HBAR topup',true);
  requireB15(hbarValue>=100_000_000_000_000_000n&&hbarValue<=1_000_000_000_000_000_000n&&hbarValue%10_000_000_000n===0n,'HBAR topup outside B14 policy');
  const minted=matchingEvents(eventsByOperation.MINT_TEUSD,'TestEnergyUSD','Transfer',a=>matches(a.from,'0x'+'0'.repeat(40))&&matches(a.to,terms.buyer)&&String(a.value)===amount);
  requireB15(minted.length===1,'Missing/duplicated exact buyer mint Transfer event');
  const approval=matchingEvents(eventsByOperation.APPROVE_ESCROW,'TestEnergyUSD','Approval',a=>matches(a.owner,terms.buyer)&&matches(a.spender,escrow)&&String(a.value)===amount);
  requireB15(approval.length===1,'Missing/duplicated exact allowance Approval event');
  const created=matchingEvents(eventsByOperation.CREATE_TRADE,'EnergyTradingEscrow','TradeCreated',a=>String(a.onChainTradeId)===String(onChainId)&&matches(a.externalTradeId,externalId)&&matches(a.buyer,terms.buyer)&&matches(a.seller,terms.seller)&&String(a.quantityWh)===String(terms.quantityWh)&&String(a.unitPriceMicrousdPerKwh)===String(terms.unitPriceMicrousdPerKwh));
  requireB15(created.length===1,'Missing/duplicated canonical TradeCreated event');
  const funded=matchingEvents(eventsByOperation.FUND_TRADE,'EnergyTradingEscrow','TradeFunded',a=>String(a.onChainTradeId)===String(onChainId)&&String(a.amount)===amount);
  const transferred=matchingEvents(eventsByOperation.FUND_TRADE,'TestEnergyUSD','Transfer',a=>matches(a.from,terms.buyer)&&matches(a.to,escrow)&&String(a.value)===amount);
  requireB15(funded.length===1&&transferred.length===1,'Missing/duplicated TradeFunded and buyer-to-escrow Transfer');
  const extra=eventsByOperation.FUND_TRADE.filter(e=>e.contract==='TestEnergyUSD'&&e.event==='Transfer'&&matches(e.args?.from,terms.buyer));
  requireB15(extra.length===1,'Unexpected additional buyer token transfer in funding transaction');
  return {mintHash:journals.get('MINT_TEUSD').txHash,approvalHash:journals.get('APPROVE_ESCROW').txHash,
    createHash:journals.get('CREATE_TRADE').txHash,fundHash:journals.get('FUND_TRADE').txHash,
    hbarHash:journals.get('FUND_BUYER_HBAR').txHash};
}
/** EVM calldata is independently bound to the same exact trade and journaled nonce. */
export function validateB15Calls({transactions,journals,callData,chainId=296}) {
  for(const op of B15_OPERATIONS) {
    const row=journals.get(op),tx=transactions[op];
    requireB15(row&&tx,`${op} signed EVM transaction missing`);
    requireB15(lower(tx.hash)===lower(row.txHash)&&lower(tx.from)===lower(row.signerAddress)&&lower(tx.to)===lower(row.targetAddress),`${op} EVM transaction sender/recipient/hash mismatch`);
    requireB15(Number(tx.chainId)===chainId&&String(tx.nonce)===row.nonce,`${op} EVM chain/nonce mismatch`);
    const data=op==='FUND_BUYER_HBAR'?'0x':callData[op];
    requireB15(typeof data==='string'&&lower(tx.data??'0x')===lower(data),`${op} EVM calldata mismatch`);
    requireB15(op==='FUND_BUYER_HBAR'?strictUnsigned(tx.value,'HBAR topup',true)>0n:strictUnsigned(tx.value,'EVM native value')===0n,
      `${op} unexpected native value`);
  }
  return true;
}

export function validateB15EscrowBalances({buyerBalance,allowance,escrowBalance,amount}) {
  requireB15(strictUnsigned(buyerBalance,'buyer balance')===0n,'Buyer must hold zero TEUSD after exact funding');
  requireB15(strictUnsigned(allowance,'escrow allowance')===0n,'Buyer must have zero remaining allowance');
  requireB15(strictUnsigned(escrowBalance,'escrow balance')>=strictUnsigned(amount,'trade payment',true),'Escrow token balance less than funded trade payment');
  return true;
}

/** Strict, line-based Prisma Trade model parsing; refuses an unknown schema instead of inventing inserts. */
export function parseB15TradeModel(source) {
  requireB15(typeof source==='string','Prisma schema text missing');
  const match=source.match(/(?:^|\n)model\s+Trade\s*\{([\s\S]*?)^\}/m);
  requireB15(match,'Prisma schema has no model Trade');
  const fields=new Map();let uniqueMatch=false;
  for(const raw of match[1].split(/\r?\n/)) {
    const line=raw.replace(/\/\/.*$/,'').trim();if(!line)continue;
    if(/^@@unique\(\[\s*matchId\s*\]/.test(line))uniqueMatch=true;
    if(line.startsWith('@'))continue;
    const m=line.match(/^(\w+)\s+([\w]+)(\[\]|\?)?\s*(.*)$/);
    requireB15(m,`Unrecognized Trade field declaration: ${line.slice(0,55)}`);
    const [_,name,type,suffix,attrs]=m;fields.set(name,{name,type,optional:suffix==='?',list:suffix==='[]',attrs,required:!suffix&&!/@default\(|@updatedAt\b/.test(attrs),relation:/@relation\(/.test(attrs)});
    if(name==='matchId'&&/@unique\b/.test(attrs))uniqueMatch=true;
  }
  requireB15(fields.has('matchId')&&fields.has('status')&&fields.has('onChainTradeId')&&uniqueMatch,'Trade model requires matchId @unique, status and onChainTradeId');
  return fields;
}
function setIfPresent(fields,obj,name,value){if(fields.has(name)&&value!==undefined)obj[name]=value;}
export function b15Projection(fields,{match,terms,onChainId,chainTrade,hashes,externalId,escrow,token}) {
  const a={matchId:match.id,buyerId:match.buyerId,sellerId:match.sellerId,buyerWallet:terms.buyer,sellerWallet:terms.seller,
    buyerAddress:terms.buyer,sellerAddress:terms.seller,onChainTradeId:String(onChainId),externalTradeId:externalId,
    quantityWh:String(terms.quantityWh),unitPriceMicrousdPerKwh:String(terms.unitPriceMicrousdPerKwh),
    totalAmountMicrousd:String(terms.totalAmountMicrousd),deliveryStart:chainTrade.deliveryStart,deliveryDeadline:chainTrade.deliveryDeadline,
    status:B15_STATUS,contractAddress:escrow,paymentTokenAddress:token,tokenAddress:token,chainId:296,
    createTxHash:hashes.createHash,creationTxHash:hashes.createHash,tradeCreationTxHash:hashes.createHash,
    fundTxHash:hashes.fundHash,fundingTxHash:hashes.fundHash,tradeFundingTxHash:hashes.fundHash,
    approveTxHash:hashes.approvalHash,approvalTxHash:hashes.approvalHash,
    mintTxHash:hashes.mintHash,hbarFundingTxHash:hashes.hbarHash,
    txHash:hashes.createHash,transactionHash:hashes.createHash,paymentTxHash:hashes.fundHash,
    createTransactionHash:hashes.createHash,fundTransactionHash:hashes.fundHash,timeSlot:match.timeSlot};
  const record={};
  for(const field of fields.values()) {
    if(field.name==='id'&&/@default\(/.test(field.attrs))continue;
    if(field.name==='tradeId'&&field.required&&/@id\b/.test(field.attrs)&&!a.tradeId) a.tradeId=deterministicTradeUuid(match.id);
    if(field.name==='id'&&field.required&&/@id\b/.test(field.attrs)&&!a.id) a.id=deterministicTradeUuid(match.id);
    const value=a[field.name];
    if(value===undefined) {
      if(field.required&&!field.relation)throw new Error(`B15 cannot safely populate required Trade.${field.name}; inspect schema before syncing`);
      continue;
    }
    requireB15(!field.list&&!field.relation,`B15 projection cannot overwrite relation/list ${field.name}`);
    if(field.type==='DateTime')record[field.name]=value instanceof Date?value:new Date(value);
    else if(field.type==='BigInt')record[field.name]=strictUnsigned(value,field.name);
    else if(field.type==='Int') {const n=Number(value);requireB15(Number.isInteger(n)&&n>=-2147483648&&n<=2147483647,`${field.name} is not int32`);record[field.name]=n;}
    else if(field.type==='Decimal') record[field.name]=String(value);
    else if(field.type==='String'||field.type==='Json')record[field.name]=value instanceof Date?value.toISOString():String(value);
    else if(field.name==='status')record[field.name]=B15_STATUS;
    else throw new Error(`B15 does not know how to populate Trade.${field.name} (${field.type})`);
  }
  const required=['matchId','onChainTradeId','status'];
  for(const name of required)requireB15(Object.hasOwn(record,name),`B15 missing ${name} in Trade projection`);
  for(const name of ['buyerId','sellerId','quantityWh','unitPriceMicrousdPerKwh','totalAmountMicrousd','deliveryStart','deliveryDeadline','contractAddress']) {
    requireB15(Object.hasOwn(record,name),`Trade model is missing required integration field ${name}`);
  }
  return record;
}
function deterministicTradeUuid(matchId) {
  const digest=createHash('sha1').update('mgl850:b15:trade-id:v1:'+matchId).digest('hex').slice(0,32).split('');
  digest[12]='5';digest[16]=((parseInt(digest[16],16)&3)|8).toString(16);
  const d=digest.join('');return `${d.slice(0,8)}-${d.slice(8,12)}-${d.slice(12,16)}-${d.slice(16,20)}-${d.slice(20)}`;
}
export function b15Compare(existing,expected) {
  if(!existing)return 'CREATE';
  requireB15(['CREATED','FUNDED',B15_STATUS].includes(existing.status),'Cannot regress a terminal/delivered trade status');
  for(const [key,want] of Object.entries(expected)) {
    const current=existing[key];
    const a=want instanceof Date?want.getTime():typeof want==='bigint'?want.toString():typeof want==='string'?want.toLowerCase():String(want);
    const b=current instanceof Date?current.getTime():typeof current==='bigint'?current.toString():typeof current==='string'?current.toLowerCase():String(current);
    if(key==='status'&&['CREATED','FUNDED'].includes(current)&&want===B15_STATUS)continue;
    requireB15(a===b,`Existing Trade.${key} conflicts with canonical B14 chain state`);
  }
  requireB15(['CREATED','FUNDED',B15_STATUS].includes(existing.status),'Cannot regress a terminal/delivered trade status');
  return existing.status===B15_STATUS?'UNCHANGED':'UPDATE';
}
export function b15SafeUpdate(existing,expected) {
  const kind=b15Compare(existing,expected);
  if(kind==='CREATE')return {kind,data:expected};
  if(kind==='UNCHANGED')return {kind,data:{}};
  return {kind,data:{status:B15_STATUS}};
}
