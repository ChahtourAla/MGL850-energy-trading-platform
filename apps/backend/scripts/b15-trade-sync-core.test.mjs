import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
 b15Args,strictUnsigned,validateB15Journal,validateB15Trade,validateB15Receipts,validateB15Calls,
 validateB15EscrowBalances,parseB15TradeModel,b15Projection,b15Compare,b15SafeUpdate,
} from './b15-trade-sync-core.mjs';
const buyer='0x'+'1'.repeat(40),seller='0x'+'2'.repeat(40),operator='0x'+'3'.repeat(40);
const admin='0x'+'4'.repeat(40),token='0x'+'5'.repeat(40),escrow='0x'+'6'.repeat(40),ZERO='0x'+'0'.repeat(40);
const matchId='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a',extId='0x'+'f'.repeat(64);
const hash=(i)=>'0x'+String(i).repeat(64);
const ops=['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'];
const amt='250232',id='2';
const terms={buyer,seller,quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:amt};
const journal=()=>ops.map((operation,i)=>({operation,matchId,externalTradeId:extId,status:'CONFIRMED',chainId:296,
 signerAddress:i===0?operator:i===1?admin:i===2?buyer:operator,targetAddress:i===0?buyer:i<3?token:escrow,
 confirmedAt:new Date('2026-11-09T22:00:00Z'),nonce:String(i),payloadSha256:'c'.repeat(64),txHash:hash(i+1)}));
const context={matchId,externalId:extId,buyer,operator,admin,token,escrow};
const trade=()=>({onChainTradeId:id,externalTradeId:extId,buyer,seller,quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:amt,
 deliveryStart:'1794366000',deliveryDeadline:'1794369600',deliveredWh:'0',status:'AWAITING_DELIVERY',statusCode:2});
const eventFixtures=()=>({
 FUND_BUYER_HBAR:[],
 MINT_TEUSD:[{contract:'TestEnergyUSD',event:'Transfer',args:{from:ZERO,to:buyer,value:amt}}],
 APPROVE_ESCROW:[{contract:'TestEnergyUSD',event:'Approval',args:{owner:buyer,spender:escrow,value:amt}}],
 CREATE_TRADE:[{contract:'EnergyTradingEscrow',event:'TradeCreated',args:{onChainTradeId:id,externalTradeId:extId,buyer,seller,quantityWh:'2188',unitPriceMicrousdPerKwh:'114366'}}],
 FUND_TRADE:[{contract:'TestEnergyUSD',event:'Transfer',args:{from:buyer,to:escrow,value:amt}},
             {contract:'EnergyTradingEscrow',event:'TradeFunded',args:{onChainTradeId:id,amount:amt}}],
});
const receiptFixture=()=>Object.fromEntries(journal().map((j,i)=>[j.operation,{status:1,hash:j.txHash,from:j.signerAddress,to:j.targetAddress,blockNumber:100+i,...(i===0?{transaction:{hash:j.txHash,from:operator,to:buyer,value:200000000000000000n}}:{})}]));
const evidence=()=>({receipts:receiptFixture(),eventsByOperation:eventFixtures(),journals:new Map(journal().map(r=>[r.operation,r])),terms,externalId:extId,onChainId:id,token,escrow,admin,operator});
function throws(fn,re){assert.throws(fn,re);}
const goodSchema=`model Trade {
 id String @id @default(uuid()) @db.Uuid
 matchId String @unique @map("match_id") @db.Uuid
 match Match @relation(fields: [matchId], references: [id])
 buyerId String @map("buyer_id") @db.Uuid
 sellerId String @map("seller_id") @db.Uuid
 buyerWallet String @db.VarChar(42)
 sellerWallet String @db.VarChar(42)
 quantityWh BigInt @db.BigInt
 unitPriceMicrousdPerKwh BigInt @db.BigInt
 totalAmountMicrousd BigInt @db.BigInt
 onChainTradeId String @db.VarChar(78)
 externalTradeId String @db.Char(66)
 deliveryStart DateTime @db.Timestamptz(3)
 deliveryDeadline DateTime @db.Timestamptz(3)
 status String @default("CREATED") @db.VarChar(24)
 contractAddress String @db.VarChar(42)
 creationTxHash String? @db.VarChar(66)
 fundingTxHash String? @db.VarChar(66)
 createdAt DateTime @default(now())
 updatedAt DateTime @updatedAt
 @@map("trades")
}`;
const projectionInput={match:{id:matchId,buyerId:matchId,sellerId:'926ed440-3271-42d2-80ef-363de236cd39',timeSlot:new Date('2026-11-09T12:00:00Z')},terms,
 onChainId:id,chainTrade:{deliveryStart:new Date(1794366000000),deliveryDeadline:new Date(1794369600000)},
 hashes:{createHash:hash(4),fundHash:hash(5),approvalHash:hash(3),mintHash:hash(2),hbarHash:hash(1)},externalId:extId,escrow,token};
const baseProjection=()=>b15Projection(parseB15TradeModel(goodSchema),projectionInput);
const positive=(name,fn)=>test(name,fn);
const fail=(name,fn,re)=>test(name,()=>throws(fn,re));
positive('default CLI is read-only preview',()=>assert.equal(b15Args(['--match-id',matchId]).action,'preview'));
positive('CLI explicit sync allowed',()=>assert.equal(b15Args(['--match-id',matchId,'--sync']).action,'sync'));
positive('CLI explicit verify allowed',()=>assert.equal(b15Args(['--verify','--match-id',matchId]).action,'verify'));
fail('CLI rejects no ID',()=>b15Args([]),/UUID/);
fail('CLI rejects forged ID',()=>b15Args(['--match-id','nope']),/UUID/);
fail('CLI rejects two actions',()=>b15Args(['--match-id',matchId,'--sync','--verify']),/one B15 action/);
fail('CLI rejects duplicate flag',()=>b15Args(['--match-id',matchId,'--match-id',matchId]),/Repeated/);
fail('CLI rejects unknown option',()=>b15Args(['--match-id',matchId,'--submit']),/Unknown/);
fail('CLI rejects no value',()=>b15Args(['--match-id']),/Missing/);
positive('canonical numeric positive',()=>assert.equal(strictUnsigned('250232','amount',true),250232n));
positive('zero allowed when non-positive',()=>assert.equal(strictUnsigned('0','balance'),0n));
for (const value of ['-1','1.2','1e2',' 1','01','abc']) fail(`noncanonical number rejected: ${value}`,()=>strictUnsigned(value,'bad'),/canonical/);
fail('zero forbidden for positive',()=>strictUnsigned('0','amount',true),/bounds/);
positive('canonical five journal rows accepted',()=>assert.equal(validateB15Journal(journal(),context).size,5));
for(const op of ops){
 fail(`${op} cannot be missing`,()=>validateB15Journal(journal().filter(r=>r.operation!==op),context),/exactly five/);
 fail(`${op} must be CONFIRMED`,()=>validateB15Journal(journal().map(r=>r.operation===op?{...r,status:'SIGNED'}:r),context),/confirmed/);
 fail(`${op} must have tx hash`,()=>validateB15Journal(journal().map(r=>r.operation===op?{...r,txHash:null}:r),context),/hash/);
 fail(`${op} must be same chain`,()=>validateB15Journal(journal().map(r=>r.operation===op?{...r,chainId:295}:r),context),/chain/);
 fail(`${op} signer cannot change`,()=>validateB15Journal(journal().map(r=>r.operation===op?{...r,signerAddress:ZERO}:r),context),/signer\/target/);
 fail(`${op} must retain same external ID`,()=>validateB15Journal(journal().map(r=>r.operation===op?{...r,externalTradeId:hash(9)}:r),context),/provenance/);
}
fail('duplicated operation rejected',()=>{const rows=journal();rows[3].operation=rows[2].operation;validateB15Journal(rows,context);},/duplicated/);
fail('duplicate tx hash rejected',()=>{const rows=journal();rows[3].txHash=rows[2].txHash;validateB15Journal(rows,context);},/share/);
fail('missing confirmedAt rejected',()=>{const rows=journal();rows[4].confirmedAt=null;validateB15Journal(rows,context);},/confirmed/);
fail('nonce missing rejected',()=>{const rows=journal();rows[4].nonce=null;validateB15Journal(rows,context);},/nonce/);
positive('on-chain trade exact verification',()=>assert.equal(validateB15Trade(trade(),{externalId:extId,terms,onChainId:id}).onChainTradeId,id));
for(const [key,bad] of [['status','CREATED'],['statusCode',1],['externalTradeId',hash(9)],['buyer',seller],['seller',buyer],['quantityWh','2189'],['unitPriceMicrousdPerKwh','114367'],['totalAmountMicrousd','250233'],['deliveryStart','0'],['deliveryDeadline','1794366000'],['deliveredWh','1']]){
 fail(`on-chain ${key} mismatch rejected`,()=>validateB15Trade({...trade(),[key]:bad},{externalId:extId,terms,onChainId:id}),/.*/);
}
fail('on-chain ID zero rejected',()=>validateB15Trade(trade(),{externalId:extId,terms,onChainId:'0'}),/not found/);
positive('all five receipts events accepted',()=>assert.equal(validateB15Receipts(evidence()).fundHash,hash(5)));
for(const op of ops){
 fail(`${op} missing receipt rejected`,()=>{const e=evidence();e.receipts[op]=null;validateB15Receipts(e);},/receipt/);
 fail(`${op} wrong receipt status rejected`,()=>{const e=evidence();e.receipts[op].status=0;validateB15Receipts(e);},/receipt/);
 fail(`${op} wrong receipt sender rejected`,()=>{const e=evidence();e.receipts[op].from=ZERO;validateB15Receipts(e);},/sender/);
 fail(`${op} unknown hash rejected`,()=>{const e=evidence();e.receipts[op].hash=hash(9);validateB15Receipts(e);},/receipt/);
}
for(const [op,name] of [['MINT_TEUSD','mint'],['APPROVE_ESCROW','allowance'],['CREATE_TRADE','created'],['FUND_TRADE','fund']]){
 fail(`${name} event missing refused`,()=>{const e=evidence();e.eventsByOperation[op]=[];validateB15Receipts(e);},/Missing/);
 fail(`${name} event duplicated refused`,()=>{const e=evidence();e.eventsByOperation[op].push(...e.eventsByOperation[op]);validateB15Receipts(e);},/Missing|Unexpected/);
}
fail('wrong mint beneficiary rejected',()=>{const e=evidence();e.eventsByOperation.MINT_TEUSD[0].args.to=seller;validateB15Receipts(e);},/mint/);
fail('wrong approval spender rejected',()=>{const e=evidence();e.eventsByOperation.APPROVE_ESCROW[0].args.spender=buyer;validateB15Receipts(e);},/Approval/);
fail('wrong trade event ID rejected',()=>{const e=evidence();e.eventsByOperation.CREATE_TRADE[0].args.externalTradeId=hash(9);validateB15Receipts(e);},/TradeCreated/);
fail('wrong trade funded amount rejected',()=>{const e=evidence();e.eventsByOperation.FUND_TRADE[1].args.amount='1';validateB15Receipts(e);},/TradeFunded/);
fail('wrong buyer-to-escrow transfer rejected',()=>{const e=evidence();e.eventsByOperation.FUND_TRADE[0].args.to=admin;validateB15Receipts(e);},/TradeFunded/);
fail('HBAR amount too small refused',()=>{const e=evidence();e.receipts.FUND_BUYER_HBAR.transaction.value=1n;validateB15Receipts(e);},/HBAR topup/);
fail('HBAR sender wrong refused',()=>{const e=evidence();e.receipts.FUND_BUYER_HBAR.transaction.from=ZERO;validateB15Receipts(e);},/HBAR top-up/);
const callFixture=()=>{
  const j=new Map(journal().map(row=>[row.operation,row]));
  const callData={MINT_TEUSD:'0x40c10f19',APPROVE_ESCROW:'0x095ea7b3',CREATE_TRADE:'0x8afccfe3',FUND_TRADE:'0x347291bd'};
  const transactions=Object.fromEntries(ops.map(op=>{const row=j.get(op);return [op,{
    hash:row.txHash,from:row.signerAddress,to:row.targetAddress,chainId:296,nonce:Number(row.nonce),
    data:op==='FUND_BUYER_HBAR'?'0x':callData[op],value:op==='FUND_BUYER_HBAR'?200000000000000000n:0n,
  }]}));
  return {transactions,journals:j,callData};
};
positive('all five canonical calldata and nonce checks pass',()=>assert.ok(validateB15Calls(callFixture())));
for(const op of ops){
  fail(`${op} changed calldata blocked`,()=>{const f=callFixture();f.transactions[op].data='0xff';validateB15Calls(f);},/calldata/);
  fail(`${op} changed nonce blocked`,()=>{const f=callFixture();f.transactions[op].nonce+=1;validateB15Calls(f);},/nonce/);
  fail(`${op} changed transaction hash blocked`,()=>{const f=callFixture();f.transactions[op].hash=hash(9);validateB15Calls(f);},/transaction/);
  fail(`${op} changed chain blocked`,()=>{const f=callFixture();f.transactions[op].chainId=1;validateB15Calls(f);},/chain/);
  fail(`${op} changed sender blocked`,()=>{const f=callFixture();f.transactions[op].from=ZERO;validateB15Calls(f);},/sender/);
}
fail('mint native value forbidden',()=>{const f=callFixture();f.transactions.MINT_TEUSD.value=1n;validateB15Calls(f);},/native/);
fail('trade funding native value forbidden',()=>{const f=callFixture();f.transactions.FUND_TRADE.value=1n;validateB15Calls(f);},/native/);
fail('zero HBAR transfer blocked',()=>{const f=callFixture();f.transactions.FUND_BUYER_HBAR.value=0n;validateB15Calls(f);},/bounds/);

positive('exact escrow balances pass',()=>assert.ok(validateB15EscrowBalances({buyerBalance:0n,allowance:0n,escrowBalance:250232n,amount:amt})));
positive('multi-trade escrow balance may exceed matched payment',()=>assert.ok(validateB15EscrowBalances({buyerBalance:0n,allowance:0n,escrowBalance:1000000n,amount:amt})));
fail('underfunded escrow rejected',()=>validateB15EscrowBalances({buyerBalance:0n,allowance:0n,escrowBalance:100n,amount:amt}),/Escrow token/);
fail('buyer with residual funds rejected',()=>validateB15EscrowBalances({buyerBalance:1n,allowance:0n,escrowBalance:250232n,amount:amt}),/Buyer/);
fail('unspent allowance rejected',()=>validateB15EscrowBalances({buyerBalance:0n,allowance:1n,escrowBalance:250232n,amount:amt}),/allowance/);
positive('parses existing Trade relation and column fields',()=>assert.equal(parseB15TradeModel(goodSchema).size,20));
fail('unknown schema no Trade blocked',()=>parseB15TradeModel('model Match {}'),/Trade/);
fail('Trade with missing unique matchId blocked',()=>parseB15TradeModel(goodSchema.replace('matchId String @unique','matchId String')),/unique/);
fail('Trade lacking onChainTradeId blocked',()=>parseB15TradeModel(goodSchema.replace('onChainTradeId String','missingOnChainId String')),/onChainTradeId/);
positive('Prisma array relation is never a required scalar field',()=>{
 const source=goodSchema.replace(' @@map("trades")',
   ' deliveryRecords DeliveryRecord[]\n tradeEvents TradeEvent[]\n @@map("trades")');
 const fields=parseB15TradeModel(source);
 assert.equal(fields.get('deliveryRecords').list,true);
 assert.equal(fields.get('deliveryRecords').required,false);
 assert.equal(fields.get('tradeEvents').list,true);
 const projected=b15Projection(fields,projectionInput);
 assert.equal(Object.hasOwn(projected,'deliveryRecords'),false);
 assert.equal(Object.hasOwn(projected,'tradeEvents'),false);
});
positive('Prisma optional relation is not required by trade projection',()=>{
 const source=goodSchema.replace(' @@map("trades")',
   ' latestDelivery DeliveryRecord?\n @@map("trades")');
 const fields=parseB15TradeModel(source);
 assert.equal(fields.get('latestDelivery').optional,true);
 assert.equal(fields.get('latestDelivery').required,false);
 assert.equal(Object.hasOwn(b15Projection(fields,projectionInput),'latestDelivery'),false);
});
fail('true unmapped required scalar still refused beside inverse relation',()=>{
 const source=goodSchema.replace(' @@map("trades")',
   ' deliveryRecords DeliveryRecord[]\n unsafeRequired String\n @@map("trades")');
 b15Projection(parseB15TradeModel(source),projectionInput);
},/unsafeRequired/);
positive('maps exact B12 values and escrow metadata into model',()=>{const p=baseProjection();assert.equal(p.totalAmountMicrousd,250232n);assert.equal(p.onChainTradeId,'2');assert.equal(p.status,'AWAITING_DELIVERY');assert.equal(p.contractAddress,escrow);assert.equal(p.creationTxHash,hash(4));assert.equal(p.fundingTxHash,hash(5));});
positive('maps UTC delivery into Date objects',()=>{const p=baseProjection();assert.ok(p.deliveryStart instanceof Date);assert.equal(p.deliveryDeadline.toISOString(),'2026-11-11T04:00:00.000Z');});
fail('schema with unknown required field refused',()=>b15Projection(parseB15TradeModel(goodSchema.replace(' id String',' mysteryRequired String\n id String')),projectionInput),/mysteryRequired/);
fail('schema missing price not considered complete',()=>b15Projection(parseB15TradeModel(goodSchema.replace(' unitPriceMicrousdPerKwh BigInt @db.BigInt','')),projectionInput),/missing required integration field unitPrice/);
positive('new trade disposition CREATE',()=>assert.equal(b15Compare(null,baseProjection()),'CREATE'));
positive('existing identical trade idempotent',()=>assert.equal(b15Compare(baseProjection(),baseProjection()),'UNCHANGED'));
positive('existing CREATED safely promoted',()=>assert.equal(b15SafeUpdate({...baseProjection(),status:'CREATED'},baseProjection()).data.status,'AWAITING_DELIVERY'));
positive('existing FUNDED safely promoted',()=>assert.equal(b15Compare({...baseProjection(),status:'FUNDED'},baseProjection()),'UPDATE'));
fail('existing COMPLETED cannot regress',()=>b15Compare({...baseProjection(),status:'COMPLETED'},baseProjection()),/regress/);
fail('different on-chain ID cannot overwrite',()=>b15Compare({...baseProjection(),onChainTradeId:'3'},baseProjection()),/onChainTradeId/);
fail('different buyer cannot overwrite',()=>b15Compare({...baseProjection(),buyerId:'other'},baseProjection()),/buyerId/);
fail('different amount cannot overwrite',()=>b15Compare({...baseProjection(),totalAmountMicrousd:100n},baseProjection()),/totalAmount/);
fail('different funding hash cannot overwrite',()=>b15Compare({...baseProjection(),fundingTxHash:hash(9)},baseProjection()),/fundingTxHash/);
positive('source does not sign or broadcast transactions',()=>{const src=readFileSync(fileURLToPath(new URL('./b15-trade-sync.mjs',import.meta.url)),'utf8');assert.doesNotMatch(src,/sendRawTransaction|eth_sendRawTransaction|\.signTransaction\(|\.createDecipheriv|PRIVATE_KEY|sendTransaction\(/);});
positive('source explicitly guards database writes',()=>{const src=readFileSync(fileURLToPath(new URL('./b15-trade-sync.mjs',import.meta.url)),'utf8');assert.match(src,/B15_SYNC_CONFIRM/);assert.match(src,/pg_advisory_xact_lock/);assert.match(src,/FOR UPDATE/);});
