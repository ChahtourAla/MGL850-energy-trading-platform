import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAudit,B14_OPERATIONS,tradeSchemaHasChainId} from './b19-audit-core.mjs';
const matchId='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const buyer='0x255d93780b72aeb3c29187765d900eae4cf67f31',seller='0x34095c456de7106d037ae9668c4b4c65bf4e6538';
const tx=i=>`0x${String(i).padStart(64,'0')}`;
const hash=tx(23);
function fixture(){
 const id='2';const b14=B14_OPERATIONS.map((operation,i)=>({operation,status:'CONFIRMED',txHash:tx(i+1),signerAddress:buyer,targetAddress:seller,chainId:296,externalTradeId:hash}));
 const receipts=Object.fromEntries(b14.map(x=>[x.operation,{status:1,hash:x.txHash,from:buyer,to:seller}]));
 const match={id:matchId,buyerId:'buyer',sellerId:'seller',status:'SELECTED',quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:'250232'};
 const trade={matchId,id:'88888888-8888-4888-8888-888888888888',buyerId:'buyer',sellerId:'seller',chainId:296,externalTradeId:hash,
  onChainTradeId:id,quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:'250232',status:'AWAITING_DELIVERY'};
 const chain={onChainTradeId:id,externalTradeId:hash,buyer,seller,quantityWh:'2188',unitPriceMicrousdPerKwh:'114366',totalAmountMicrousd:'250232',
  deliveryStart:'1794366000',deliveryDeadline:'1794369600',status:'AWAITING_DELIVERY'};
 return {match,trade,chain,chainLookup:id,chainId:296,tradeSchemaHasChainId:true,deployment:{chainId:296,confirmedBytecode:true,paymentTokenMatches:true,tokenDecimals:6,tokenSymbol:'TEUSD'},
  buyerWallet:{evmAddress:buyer},sellerWallet:{evmAddress:seller},b14,b16:null,b17:[],deliveries:[],escrowBalance:'250232',receipts};
}
const clone=()=>structuredClone(fixture());
const valid=()=>assert.equal(validateAudit(clone()).category,'FUNDED_PENDING_DELIVERY');
test('valid funded B12-B18 snapshot, 5 receipts and exact amount',valid);
test('B15 compatible Trade schema without chainId retains B14-confirmed chain provenance',()=>{
 const f=clone();delete f.trade.chainId;f.tradeSchemaHasChainId=false;
 assert.equal(validateAudit(f).category,'FUNDED_PENDING_DELIVERY');
});
test('Trade missing chainId when the actual schema expects it is refused',()=>{
 const f=clone();delete f.trade.chainId;
 assert.throws(()=>validateAudit(f),/schema\/record mismatch/);
});
test('Unexpected extra trade chainId field not in schema is refused',()=>{
 const f=clone();f.tradeSchemaHasChainId=false;
 assert.throws(()=>validateAudit(f),/schema\/record mismatch/);
});
test('Null persisted chainId is rejected and never silently filled',()=>{
 const f=clone();f.trade.chainId=null;
 assert.throws(()=>validateAudit(f),/Invalid DB chainId/);
});
test('No schema presence proof is rejected',()=>{
 const f=clone();delete f.tradeSchemaHasChainId;
 assert.throws(()=>validateAudit(f),/schema check missing/);
});
test('Confirmed B14 chain mismatch is rejected even without Trade.chainId',()=>{
 const f=clone();delete f.trade.chainId;f.tradeSchemaHasChainId=false;f.b14[2].chainId=295;
 assert.throws(()=>validateAudit(f),/provenance mismatch/);
});
test('Confirmed B14 external trade ID mismatch is rejected even without Trade.chainId',()=>{
 const f=clone();delete f.trade.chainId;f.tradeSchemaHasChainId=false;f.b14[3].externalTradeId=tx(999);
 assert.throws(()=>validateAudit(f),/provenance mismatch/);
});
test('Trade model parser distinguishes present and absent chainId',()=>{
 assert.equal(tradeSchemaHasChainId('model Trade {\n  id String @id\n}'),false);
 assert.equal(tradeSchemaHasChainId('model Trade {\n  id String @id\n  chainId Int @default(296)\n}'),true);
 assert.throws(()=>tradeSchemaHasChainId('model Match {\n id String\n}'),/one Prisma Trade model/);
 assert.throws(()=>tradeSchemaHasChainId('model Trade {\n chainId Json\n}'),/Unsupported Prisma Trade.chainId/);
});
test('summary never includes secret fields',()=>{const r=validateAudit(clone());for(const key of ['signedTxCiphertext','privateKey','rawTransaction','evidencePayload','txHash'])assert.equal(Object.hasOwn(r,key),false);});
test('audit has no write intent',()=>{const r=validateAudit(clone());assert.equal(r.blockchainWriteRequested,false);assert.equal(r.databaseWriteRequested,false);});
for(const [name,mutation] of [
 ['wrong chain',x=>x.chainId=295],['wrong deployed chain',x=>x.deployment.chainId=295],
 ['deployment bytecode',x=>x.deployment.confirmedBytecode=false],['paymentToken',x=>x.deployment.paymentTokenMatches=false],
 ['token decimals',x=>x.deployment.tokenDecimals=18],['symbol',x=>x.deployment.tokenSymbol='USD'],
 ['missing match',x=>x.match=null],['bad match state',x=>x.match.status='PENDING'],['missing trade',x=>x.trade=null],
 ['wrong buyer relation',x=>x.trade.buyerId='imposter'],['wrong seller relation',x=>x.trade.sellerId='imposter'],
 ['wallet missing',x=>x.buyerWallet=null],['wallet seller mismatch',x=>x.sellerWallet.evmAddress=buyer],
 ['onchain buyer mismatch',x=>x.chain.buyer=seller],['onchain seller mismatch',x=>x.chain.seller=buyer],
 ['bad external ID',x=>x.chain.externalTradeId=tx(57)],['bad lookup',x=>x.chainLookup='3'],
 ['zero lookup',x=>x.chainLookup='0'],['bad numeric id',x=>x.trade.onChainTradeId='x'],['wrong DB chain',x=>x.trade.chainId=1],
 ['mismatched Wh',x=>x.chain.quantityWh='2200'],['DB Wh mismatch',x=>x.trade.quantityWh='2200'],
 ['match Wh mismatch',x=>x.match.quantityWh='2200'],['unit price mismatch',x=>x.chain.unitPriceMicrousdPerKwh='20'],
 ['DB unit price mismatch',x=>x.trade.unitPriceMicrousdPerKwh='20'],['match unit price mismatch',x=>x.match.unitPriceMicrousdPerKwh='20'],
 ['chain payment mismatch',x=>x.chain.totalAmountMicrousd='1'],['DB payment mismatch',x=>x.trade.totalAmountMicrousd='1'],
 ['match payment mismatch',x=>x.match.totalAmountMicrousd='1'],['DB status drift',x=>x.trade.status='COMPLETED'],
 ['unknown chain status',x=>x.chain.status='FAILED'],['inverted time',x=>x.chain.deliveryStart=x.chain.deliveryDeadline],
 ['missing B14 entry',x=>x.b14.pop()],['extra B14 entry',x=>x.b14.push({...x.b14[0]})],
 ['duplicate B14 op',x=>x.b14[1].operation=x.b14[0].operation],['B14 unconfirmed',x=>x.b14[0].status='SIGNED'],
 ['B14 absent txhash',x=>x.b14[0].txHash=null],['missing receipt',x=>x.receipts[B14_OPERATIONS[0]]=null],
 ['failed receipt',x=>x.receipts[B14_OPERATIONS[0]].status=0],['wrong receipt hash',x=>x.receipts[B14_OPERATIONS[0]].hash=tx(888)],
 ['wrong receipt sender',x=>x.receipts[B14_OPERATIONS[0]].from=seller],['wrong receipt target',x=>x.receipts[B14_OPERATIONS[0]].to=buyer],
 ['no escrow',x=>x.escrowBalance='1'],['unexpected delivery',x=>x.deliveries.push({status:'PENDING'})],
 ['existing B16 planned',x=>x.b16={status:'PLANNED'}],['existing B16 signed',x=>x.b16={status:'SIGNED'}],
 ['existing B16 submitted',x=>x.b16={status:'SUBMITTED'}],['existing B16 uncertain',x=>x.b16={status:'NEEDS_RECONCILIATION'}],
 ['existing B16 confirmed while funded',x=>x.b16={status:'CONFIRMED'}],
 ['B17 planned',x=>x.b17=[{operation:'EXPIRE',status:'PLANNED'}]],
 ['B17 signed',x=>x.b17=[{operation:'EXPIRE',status:'SIGNED'}]],
 ['B17 submitted',x=>x.b17=[{operation:'EXPIRE',status:'SUBMITTED'}]],
 ['B17 uncertain',x=>x.b17=[{operation:'EXPIRE',status:'NEEDS_RECONCILIATION'}]],
 ['B17 confirmed while funded',x=>x.b17=[{operation:'EXPIRE',status:'CONFIRMED'}]],
 ['malformed token amount',x=>x.chain.totalAmountMicrousd='1e2'],
]) test(`rejects ${name}`,()=>{const f=clone();mutation(f);assert.throws(()=>validateAudit(f));});
function complete(){const f=clone();f.chain.status='COMPLETED';f.trade.status='COMPLETED';f.b16={status:'CONFIRMED',txHash:tx(88),confirmedAt:'now',syncedAt:'now'};
 f.deliveries=[{status:'CONFIRMED',deliveredWh:'2188'}];return f;}
test('completed seller payout with oracle confirmation',()=>assert.equal(validateAudit(complete()).category,'SELLER_SETTLED'));
test('completed without matching delivery rejected',()=>{const f=complete();f.deliveries=[];assert.throws(()=>validateAudit(f));});
test('completed with incomplete delivery rejected',()=>{const f=complete();f.deliveries[0].deliveredWh='2187';assert.throws(()=>validateAudit(f));});
test('completed without synced B16 journal rejected',()=>{const f=complete();f.b16.syncedAt=null;assert.throws(()=>validateAudit(f));});
test('completed and refunded impossible',()=>{const f=complete();f.b17=[{operation:'REFUND',status:'CONFIRMED'}];assert.throws(()=>validateAudit(f));});
function expired(){const f=clone();f.chain.status='EXPIRED';f.trade.status='EXPIRED';f.b17=[{operation:'EXPIRE',status:'CONFIRMED',syncedAt:'now'}];return f;}
test('expired awaiting buyer refund is explicitly not completed',()=>assert.equal(validateAudit(expired()).category,'EXPIRED_REFUND_PENDING'));
test('expired requires confirmed B17 expire intent',()=>{const f=expired();f.b17=[];assert.throws(()=>validateAudit(f));});
test('expired blocks unresolved B16 oracle claim',()=>{const f=expired();f.b16={status:'SUBMITTED'};assert.throws(()=>validateAudit(f));});
function refunded(){const f=expired();f.chain.status='REFUNDED';f.trade.status='REFUNDED';f.b17.push({operation:'REFUND',status:'CONFIRMED',txHash:tx(91),syncedAt:'now'});return f;}
test('refund requires confirmed expiration and refund',()=>assert.equal(validateAudit(refunded()).category,'BUYER_REFUNDED'));
test('refund missing sync rejects',()=>{const f=refunded();f.b17[1].syncedAt=null;assert.throws(()=>validateAudit(f));});
test('refund and B16 confirmed rejects',()=>{const f=refunded();f.b16={status:'CONFIRMED'};assert.throws(()=>validateAudit(f));});
function cancelled(){const f=clone();f.chain.status='CANCELLED';f.trade.status='CANCELLED';f.b17=[{operation:'CANCEL',status:'CONFIRMED',syncedAt:'now'}];return f;}
test('cancelled journal verifies',()=>assert.equal(validateAudit(cancelled()).category,'UNFUNDED_CANCELLED'));
test('cancelled without sync rejects',()=>{const f=cancelled();f.b17[0].syncedAt=null;assert.throws(()=>validateAudit(f));});
test('created is not a funded end-to-end state',()=>{const f=clone();f.chain.status='CREATED';f.trade.status='CREATED';assert.throws(()=>validateAudit(f));});
test('B19 audit executable has no signing or transaction broadcast code',async()=>{
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const src=readFileSync(fileURLToPath(new URL('./b19-audit.mjs',import.meta.url)),'utf8');
 for(const banned of [/sendRawTransaction/i,/sendTransaction\s*\(/i,/\.signTransaction\s*\(/i,/\.\$transaction\s*\(/i,/\.(?:create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(/i,/process\.env\.HEDERA_(?:OPERATOR|ORACLE)_PRIVATE_KEY/i]){
  assert.equal(banned.test(src),false,`Unexpected write/signer operation: ${banned}`);
 }
});
test('B19 CLI requires single UUID and has no execute/settlement mode',async()=>{
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const src=readFileSync(fileURLToPath(new URL('./b19-audit.mjs',import.meta.url)),'utf8');
 assert.ok(src.includes("args.length!==2||args[0]!=='--match-id'"));
 assert.ok(!src.includes("'--execute'"));
});
