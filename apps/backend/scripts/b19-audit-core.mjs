/** B19 read-only cross-layer invariants. No DB, network, signer or file-system effects. */
export const B14_OPERATIONS = Object.freeze(['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE']);
export const UNSAFE_PENDING = Object.freeze(['PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION']);
export const TERMINAL = Object.freeze(['COMPLETED','CANCELLED','REFUNDED']);
export const STATUS = Object.freeze(['CREATED','AWAITING_DELIVERY','EXPIRED','COMPLETED','CANCELLED','REFUNDED']);
const POS = /^(?:0|[1-9]\d*)$/;
const HEX32 = /^0x[\da-f]{64}$/i;
const ADDR = /^0x[\da-f]{40}$/i;
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
export function requireSafe(value, message) { if (!value) throw new Error(message); }
function integer(value, key) {
  const str=String(value);
  requireSafe(POS.test(str)&&str.length<79,`Invalid ${key}`);
  return BigInt(str);
}
/** Verify the deployed Prisma Trade model before using an optional chainId column. */
export function tradeSchemaHasChainId(source) {
  requireSafe(typeof source==='string','Prisma schema unavailable');
  const models=[...source.matchAll(/(?:^|\n)model\s+Trade\s*\{([\s\S]*?)^\}/gm)];
  requireSafe(models.length===1,'Expected exactly one Prisma Trade model');
  const declarations=models[0][1].split(/\r?\n/).map(line=>line.replace(/\/\/.*$/,'').trim())
    .filter(line=>/^chainId\s/.test(line));
  requireSafe(declarations.length<=1,'Duplicate Prisma Trade.chainId declarations');
  if(declarations.length) {
    requireSafe(/^chainId\s+(?:Int|BigInt|String)\??(?:\s|$)/.test(declarations[0]),'Unsupported Prisma Trade.chainId type');
  }
  return declarations.length===1;
}
export function validateAudit(snapshot) {
  const {match,trade,chain,chainLookup,chainId,deployment,tradeSchemaHasChainId:dbHasChainId,buyerWallet,sellerWallet,
    b14,b16,b17,deliveries,escrowBalance,receipts}=snapshot;
  requireSafe(chainId===296&&deployment?.chainId===296&&deployment.confirmedBytecode===true&&deployment.paymentTokenMatches===true&&deployment.tokenDecimals===6&&deployment.tokenSymbol==='TEUSD',
    'Canonical Hedera Testnet deployment mismatch');
  requireSafe(match?.status==='SELECTED'&&trade&&chain&&match.id===trade.matchId,'Selected source match and Trade required');
  requireSafe(match.buyerId===trade.buyerId&&match.sellerId===trade.sellerId,'Trade does not belong to matching participants');
  requireSafe(ADDR.test(buyerWallet?.evmAddress??'')&&ADDR.test(sellerWallet?.evmAddress??'')&&!same(buyerWallet.evmAddress,sellerWallet.evmAddress),'Verified B07 wallets missing');
  requireSafe(same(chain.buyer,buyerWallet.evmAddress)&&same(chain.seller,sellerWallet.evmAddress),'Wallets disagree with escrow trade parties');
  requireSafe(HEX32.test(chain.externalTradeId??'')&&same(chain.externalTradeId,trade.externalTradeId),'External trade ID mismatch');
  requireSafe(integer(chainLookup,'lookup trade ID')>0n&&integer(trade.onChainTradeId,'DB trade ID')===integer(chainLookup,'lookup ID'),'External ID lookup mismatch');
  requireSafe(String(chain.onChainTradeId)===String(chainLookup),'Wrong on-chain trade');
  // B15 supports Trade schemas without chainId; never invent the field or mutate the DB.
  // Require agreement between the real schema and the full scalar Prisma record.
  requireSafe(typeof dbHasChainId==='boolean','Prisma Trade chainId schema check missing');
  requireSafe(Object.hasOwn(trade,'chainId')===dbHasChainId,'Prisma Trade chainId schema/record mismatch');
  if(dbHasChainId) requireSafe(integer(trade.chainId,'DB chainId')===296n,'Database chain ID mismatch');
  for(const key of ['quantityWh','unitPriceMicrousdPerKwh','totalAmountMicrousd']) {
    const a=integer(chain[key],`chain.${key}`);
    requireSafe(a===integer(trade[key],`trade.${key}`)&&a===integer(match[key],`match.${key}`),`B12/B15/chain ${key} mismatch`);
  }
  requireSafe(STATUS.includes(chain.status)&&chain.status===trade.status,'On-chain and PostgreSQL status drift; reconcile before proceeding');
  requireSafe(integer(chain.deliveryStart,'start')<integer(chain.deliveryDeadline,'deadline'),'Invalid delivery window');
  requireSafe(Array.isArray(b14)&&b14.length===5,'Expected exactly five B14 journal entries');
  const opSet=new Set();
  for (const row of b14) {
    requireSafe(B14_OPERATIONS.includes(row.operation)&&!opSet.has(row.operation)&&row.status==='CONFIRMED'&&HEX32.test(row.txHash??''),
      'B14 journal must contain unique CONFIRMED entries and receipt hashes');
    // If Trade has no chainId column, confirmed B14 intents are the persisted
    // chain provenance. Enforce this even when Trade.chainId *does* exist.
    requireSafe(integer(row.chainId,'B14 chainId')===296n&&same(row.externalTradeId,trade.externalTradeId),
      `B14 chain/external trade provenance mismatch: ${row.operation}`);
    opSet.add(row.operation);
    const receipt=receipts?.[row.operation];
    requireSafe(receipt&&receipt.status===1&&same(receipt.hash,row.txHash)&&same(receipt.from,row.signerAddress)&&same(receipt.to,row.targetAddress),
      `Missing or mismatched on-chain receipt: ${row.operation}`);
  }
  requireSafe(opSet.size===5,'B14 operations incomplete');
  requireSafe(!b16||(!UNSAFE_PENDING.includes(b16.status)&&['CONFIRMED','REVERTED'].includes(b16.status)),'Unresolved B16 oracle intent: reconcile exact transaction hash; do not broadcast again');
  requireSafe(Array.isArray(b17),'B17 operator journal must be an array');
  requireSafe(b17.every(x=>!UNSAFE_PENDING.includes(x.status)&&['CONFIRMED','REVERTED'].includes(x.status)),'Unresolved B17 transaction intent: reconcile exact hash; do not broadcast again');
  requireSafe(new Set(b17.map(x=>x.operation)).size===b17.length&&b17.every(x=>['CANCEL','EXPIRE','REFUND'].includes(x.operation)),
    'Duplicate or unsupported B17 operation');
  const operation= name => b17.find(x=>x.operation===name);
  const quantity=integer(chain.quantityWh,'energy');
  const amount=integer(chain.totalAmountMicrousd,'escrow amount');
  requireSafe(quantity>0n&&amount>0n,'Non-positive energy or payment');
  requireSafe(Array.isArray(deliveries),'DeliveryRecord retrieval missing');
  let category='FUNDED_PENDING_DELIVERY';
  if(chain.status==='AWAITING_DELIVERY') {
    requireSafe(!b16&&!b17.length&&!deliveries.length,'Funded trade has settlement/recovery artifacts requiring investigation');
    requireSafe(integer(escrowBalance,'escrow balance')>=amount,'Escrow token balance is insufficient for funded trade');
  } else if(chain.status==='COMPLETED') {
    category='SELLER_SETTLED';
    requireSafe(b16?.status==='CONFIRMED'&&b16.confirmedAt&&b16.syncedAt&&HEX32.test(b16.txHash??''),
      'Completed trade requires confirmed/synced B16 oracle intent');
    requireSafe(!b17.some(x=>['EXPIRE','REFUND'].includes(x.operation)&&x.status==='CONFIRMED'),
      'Trade cannot be both settled and refunded');
    requireSafe(deliveries.length===1&&deliveries[0].status==='CONFIRMED'&&integer(deliveries[0].deliveredWh,'deliveredWh')>=quantity,
      'Completed trade requires one confirmed delivery record');
  } else if(chain.status==='EXPIRED') {
    category='EXPIRED_REFUND_PENDING';
    requireSafe(operation('EXPIRE')?.status==='CONFIRMED'&&operation('EXPIRE').syncedAt&&
      !operation('REFUND')&&(!b16||b16.status==='REVERTED'),'Expiration journal inconsistent');
    requireSafe(integer(escrowBalance,'escrow balance')>=amount,'Expired trade refund is undercollateralized');
  } else if(chain.status==='REFUNDED') {
    category='BUYER_REFUNDED';
    requireSafe(operation('EXPIRE')?.status==='CONFIRMED'&&operation('EXPIRE').syncedAt&&
      operation('REFUND')?.status==='CONFIRMED'&&operation('REFUND').syncedAt&&(!b16||b16.status==='REVERTED'),
      'Refund requires verified/synced expiration and refund journal');
  } else if(chain.status==='CANCELLED') {
    category='UNFUNDED_CANCELLED';
    requireSafe(operation('CANCEL')?.status==='CONFIRMED'&&operation('CANCEL').syncedAt&&
      !operation('REFUND')&&!b16,'Unfunded cancellation journal inconsistent');
  } else {
    // B15 currently materializes funded trades. CREATED is valid on chain but not an accepted B19 funded E2E outcome.
    throw new Error('Created but unfunded trade is not an accepted completed B14–B18 integration scenario');
  }
  return Object.freeze({category,chainId:296,onChainTradeId:String(chainLookup),
    matchId:match.id,dbStatus:trade.status,chainStatus:chain.status,b14Confirmed:b14.length,
    b16Status:b16?.status??'NONE',b17Operations:b17.map(x=>`${x.operation}:${x.status}`),
    deliveryRecords:deliveries.length,amountMicroTEUSD:amount.toString(),
    statusAligned:true,blockchainWriteRequested:false,databaseWriteRequested:false});
}
