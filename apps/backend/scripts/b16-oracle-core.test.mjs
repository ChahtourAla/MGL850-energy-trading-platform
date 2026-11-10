import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
 argsB16, unsigned, utc, validateWindow, simulationPlan, validateDelivery, evidenceCommitment,
 checkPrerequisites, feeQuote, transitions, receiptResult, verifySettlement,
 safeDbProjection, parseModel,
} from './b16-oracle-core.mjs';
const id='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a',tradeId='e21d6d57-05d8-4fdd-ae27-79a1b6450d0e',
 buyerId='926ed440-3271-42d2-80ef-363de236cd39',sellerId='9c3b143c-b3d3-4dd1-8506-ef39a4a13454';
const evm=n=>'0x'+n.toString(16).padStart(40,'0');const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const ctx={matchId:id,tradeId,onChainTradeId:'2',sellerId,buyerId,expectedWh:'2188',deliveryStart:'1794366000',deliveryDeadline:'1794369600',escrow:evm(2),externalTradeId:hash(80)};
const good=()=>({deliveryId:'cfb32b6e-cb66-5a01-80a3-3e7bd8eb6c4e',tradeId,onChainTradeId:2,sellerId,buyerId,
 expectedWh:2188,deliveredWh:2188,timeSlot:'2026-11-11T03:30:00Z',status:'SUCCESS'});
const now=1794367860n;
const journals=()=>['FUND_BUYER_HBAR','MINT_TEUSD','APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'].map((operation,i)=>({operation,status:'CONFIRMED',txHash:hash(i+1)}));
const trade=()=>({...ctx,buyer:evm(3),seller:evm(4),quantityWh:'2188',totalAmountMicrousd:'250232',status:'AWAITING_DELIVERY',statusCode:2});
const pre=()=>({chain:296,trade:trade(),dbTrade:{status:'AWAITING_DELIVERY',onChainTradeId:'2'},match:{status:'SELECTED'},
 journal:journals(),onChainId:'2',expectedExternalId:ctx.externalTradeId,oracleHasRole:true,escrowPaused:false,nowSeconds:now,escrowBalance:250232n});
const events=proof=>[
 {contract:'EnergyTradingEscrow',event:'DeliveryConfirmed',args:{onChainTradeId:'2',deliveredWh:'2188',evidenceHash:proof.evidenceHash}},
 {contract:'EnergyTradingEscrow',event:'TradeSettled',args:{onChainTradeId:'2',seller:evm(4),amount:'250232'}},
 {contract:'TestEnergyUSD',event:'Transfer',args:{from:evm(2),to:evm(4),value:'250232'}}];
const proof={evidenceHash:hash(123),deliveredWh:'2188'};
const settled=()=>({...trade(),status:'COMPLETED',statusCode:4,deliveredWh:'2188',evidenceHash:proof.evidenceHash});
const validateEvents=(extra={})=>verifySettlement({events:events(proof),trade:settled(),proof,onChainId:'2',seller:evm(4),escrow:evm(2),token:evm(1),amount:'250232',...extra});
const fieldSchema=`model DeliveryRecord {
 id String @id @default(uuid()) @db.Uuid
 tradeId String @map("trade_id") @db.Uuid
 trade Trade @relation(fields:[tradeId], references:[id])
 onChainTradeId String @db.VarChar(78)
 sellerId String @db.Uuid
 buyerId String @db.Uuid
 expectedWh BigInt @db.BigInt
 deliveredWh BigInt @db.BigInt
 timeSlot DateTime @db.Timestamptz(3)
 status String @default("PENDING") @db.VarChar(24)
 evidenceHash String? @db.Char(66)
 createdAt DateTime @default(now())
}
`;
function reject(f,fragment){assert.throws(f,new RegExp(fragment,'i'));}
for (const [label,args,expected] of [
 ['preflight default',['--match-id',id],'preflight'],['simulate',['--match-id',id,'--action','simulate','--output','x.json'],'simulate'],
 ['execute',['--match-id',id,'--action','execute','--evidence','r.json'],'execute'],
 ['reconcile',['--match-id',id,'--action','reconcile'],'reconcile'],
 ['sync',['--match-id',id,'--action','sync'],'sync'],['verify',['--match-id',id,'--action','verify'],'verify']]){
 test('CLI '+label,()=>assert.equal(argsB16(args).action,expected));
}
for(const [name,args] of [
 ['missing ID',[]],['forged ID',['--match-id','bad']],['unknown action',['--match-id',id,'--action','submit']],
 ['duplicate flag',['--match-id',id,'--match-id',id]],['unknown flag',['--match-id',id,'--nonce','3']],
 ['execute no evidence',['--match-id',id,'--action','execute']],['preflight unwanted evidence',['--match-id',id,'--evidence','x']],
 ['simulate no output',['--match-id',id,'--action','simulate']],['simulate with evidence',['--match-id',id,'--action','simulate','--output','x','--evidence','y']],
 ['invalid deliveredWh',['--match-id',id,'--action','simulate','--output','x','--delivered-wh','1e9']]]){
 test('CLI rejects '+name,()=>reject(()=>argsB16(args),'required|option|duplicate|missing|Unsupported|only|canonical|evidence|action|uuid'));
}
for(const v of ['-1','01','1e2','1.2',' 2','2 ','abc','+2','',undefined,null]){
 test('invalid integer '+String(v),()=>reject(()=>unsigned(v,'amount'),'canonical'));
}
test('unsigned canonical amount',()=>assert.equal(unsigned('250232','amount').toString(),'250232'));
test('unsigned positive disallows zero',()=>reject(()=>unsigned('0','n',true),'out of range'));
test('UTC valid',()=>assert.equal(utc('2026-11-11T03:30:00Z').toISOString(),'2026-11-11T03:30:00.000Z'));
for(const x of ['2026-11-11T03:30:00+00:00','2026-11-11 03:30:00','2026-11-11T03:30:00.1234Z','invalid']){
 test('UTC rejects '+x,()=>reject(()=>utc(x),'UTC'));
}
test('window early is not in range',()=>assert.equal(validateWindow(1794365900n,ctx.deliveryStart,ctx.deliveryDeadline).inWindow,false));
test('window rejects early settlement',()=>reject(()=>validateWindow(1794365900n,ctx.deliveryStart,ctx.deliveryDeadline,{fresh:true}),'inside'));
test('window late refuses',()=>reject(()=>validateWindow(1794369610n,ctx.deliveryStart,ctx.deliveryDeadline,{fresh:true}),'inside'));
test('window valid',()=>assert.equal(validateWindow(now,ctx.deliveryStart,ctx.deliveryDeadline,{fresh:true}).inWindow,true));
test('window inversion refuses',()=>reject(()=>validateWindow(now,1794369600,1794366000),'invalid'));
test('simulator allows isolated dry run before delivery without changing real window',()=>{
 const p=simulationPlan(1794360000n,ctx.deliveryStart,ctx.deliveryDeadline);
 assert.equal(p.mode,'ISOLATED_DRY_RUN');assert.equal(p.start,1794358200n);assert.equal(p.deadline,1794361800n);
});
test('simulator allows isolated dry run after delivery (never settlement evidence)',()=>{
 const p=simulationPlan(1794370000n,ctx.deliveryStart,ctx.deliveryDeadline);
 assert.equal(p.mode,'ISOLATED_DRY_RUN');assert.equal(p.start,1794368200n);assert.equal(p.deadline,1794371800n);
});
test('simulator uses exact live delivery window when active',()=>{
 const p=simulationPlan(now,ctx.deliveryStart,ctx.deliveryDeadline);
 assert.equal(p.mode,'LIVE_EVIDENCE');assert.equal(p.start,1794366000n);assert.equal(p.deadline,1794369600n);
});
test('real settlement window restriction remains strict',()=>reject(()=>validateWindow(1794360000n,ctx.deliveryStart,ctx.deliveryDeadline,{fresh:true}),'inside'));

test('valid evidence proof',()=>assert.equal(validateDelivery(good(),ctx,now).deliveredWh,'2188'));
const altered=[
 ['wrong trade UUID',{tradeId:id},'mismatch'],['wrong seller',{sellerId:buyerId},'mismatch'],['wrong buyer',{buyerId:sellerId},'mismatch'],
 ['wrong onchain id',{onChainTradeId:3},'mismatch'],['wrong expected',{expectedWh:2000},'Expected'],
 ['under delivered',{deliveredWh:2187},'Insufficient'],['over delivered',{deliveredWh:3000},'exceed'],
 ['not SUCCESS',{status:'INCOMPLETE'},'SUCCESS'],['pending',{status:'PENDING'},'SUCCESS'],['confirmed',{status:'CONFIRMED'},'SUCCESS'],
 ['invalid time',{timeSlot:'2026-11-11T04:00:01Z'},'timestamp'],
 ['too old',{timeSlot:'2026-11-11T03:01:00Z'},'stale'],['future timestamp',{timeSlot:'2026-11-11T03:55:00Z'},'Future'],
 ['untrusted evidenceHash',{evidenceHash:hash(9)},'self-attest'],['extra JSON field',{foo:'bar'},'Unexpected'],
 ['wrong UUID',{deliveryId:'bad'},'UUID']
];
for(const [label,change,err] of altered){test('delivery refuses '+label,()=>reject(()=>validateDelivery({...good(),...change},ctx,now),err));}
test('delivery requires fields',()=>{const r=good();delete r.tradeId;reject(()=>validateDelivery(r,ctx,now),'missing');});
test('delivery before real window refuses',()=>reject(()=>validateDelivery(good(),ctx,1794365900n),'inside'));
test('delivery proof commitment deterministic',()=>assert.equal(evidenceCommitment(good(),ctx),evidenceCommitment({...good()},ctx)));
test('delivery proof commitment 32 bytes',()=>assert.match(evidenceCommitment(good(),ctx),/^0x[0-9a-f]{64}$/));
for(const [label,change,err] of [
 ['wrong chain',{chain:1},'Wrong'],['paused',{escrowPaused:true},'Wrong'],['no oracle role',{oracleHasRole:false},'Oracle'],
 ['wrong match',{match:{status:'REJECTED'}},'SELECTED'],['journal absent',{journal:[]},'five'],
 ['journal unconfirmed',{journal:journals().map((r,i)=>i===1?{...r,status:'SIGNED'}:r)},'incomplete'],
 ['chain id missing',{onChainId:0},'range'],['chain wrong external',{trade:{...trade(),externalTradeId:hash(10)}},'mismatch'],
 ['chain not funded',{trade:{...trade(),status:'CREATED'}},'not funded'],
 ['wrong db state',{dbTrade:{status:'CREATED',onChainTradeId:'2'}},'funded'],
 ['wrong db trade id',{dbTrade:{status:'AWAITING_DELIVERY',onChainTradeId:'3'}},'funded'],
 ['escrow underpaid',{escrowBalance:250231n},'insufficient']]){
 test('oracle preflight refuses '+label,()=>reject(()=>checkPrerequisites({...pre(),...change}),err));
}
test('oracle preflight good',()=>assert.equal(checkPrerequisites(pre()).inWindow,true));
test('oracle quote good',()=>{const g=feeQuote({estimate:70000n,gasPrice:1000000000000n,balance:1000000000000000000n});assert.equal(g.gasLimit,84000n);});
for(const [name,q,err] of [
 ['underfunded',{estimate:70000n,gasPrice:1000000000000n,balance:100n},'lacks'],
 ['high gas limit',{estimate:610000n,gasPrice:1000n,balance:1000000000000000000n},'cap'],
 ['fee cap',{estimate:500000n,gasPrice:2000000000000n,balance:2000000000000000000n},'cap'],
 ['zero price',{estimate:70000n,gasPrice:0n,balance:1000000000000000000n},'out of range']]){
 test('oracle fee refuses '+name,()=>reject(()=>feeQuote(q),err));
}
for (const [a,b] of [['PLANNED','SIGNED'],['SIGNED','SUBMITTED'],['SIGNED','CONFIRMED'],['SUBMITTED','CONFIRMED'],['SUBMITTED','NEEDS_RECONCILIATION'],['NEEDS_RECONCILIATION','CONFIRMED'],['NEEDS_RECONCILIATION','REVERTED']]){
 test(`journal transition ${a}->${b}`,()=>assert.equal(transitions(a,b),true));
}
for (const [a,b] of [['PLANNED','SUBMITTED'],['SIGNED','PLANNED'],['CONFIRMED','SIGNED'],['REVERTED','SUBMITTED'],['NEEDS_RECONCILIATION','SUBMITTED']]){
 test(`journal disallows ${a}->${b}`,()=>reject(()=>transitions(a,b),'Unsafe'));
}
const signedRow={nonce:'5',txHash:hash(7)};const transaction={hash:hash(7),from:evm(6),to:evm(2),data:'0xabcdef',nonce:5,chainId:296};const receipt={hash:hash(7),from:evm(6),to:evm(2),status:1};
const checkResult=(r,t)=>receiptResult({row:signedRow,receipt:r,transaction:t,oracle:evm(6),escrow:evm(2),calldata:'0xabcdef'});
test('receipt confirmed',()=>assert.equal(checkResult(receipt,transaction),'CONFIRMED'));
test('receipt reverted',()=>assert.equal(checkResult({...receipt,status:0},transaction),'REVERTED'));
test('receipt pending',()=>assert.equal(checkResult(null,transaction),'PENDING'));
test('receipt unknown',()=>assert.equal(checkResult(null,null),'UNKNOWN'));
for(const [name,change,err] of [
 ['wrong hash',{hash:hash(4)},'differs'],['wrong sender',{from:evm(10)},'differs'],['wrong target',{to:evm(10)},'differs'],['missing status',{status:null},'status']]){
 test('receipt refuses '+name,()=>reject(()=>checkResult({...receipt,...change},transaction),err));
}
for(const [name,change] of [['wrong calldata',{data:'0xffff'}],['wrong nonce',{nonce:6}],['wrong chain',{chainId:1}],['wrong sender',{from:evm(12)}]]){
 test('transaction refuses '+name,()=>reject(()=>checkResult(receipt,{...transaction,...change}),'immutable'));
}
test('verified payout events and state',()=>assert.equal(validateEvents(),true));
for(const [name,change,err] of [
 ['missing DeliveryConfirmed',{events:events(proof).slice(1)},'Missing'],
 ['missing TradeSettled',{events:[events(proof)[0],events(proof)[2]]},'Missing'],
 ['missing seller Transfer',{events:events(proof).slice(0,2)},'Missing'],
 ['duplicated DeliveryConfirmed',{events:[...events(proof),events(proof)[0]]},'Missing'],
 ['wrong seller',{seller:evm(9)},'Missing'],
 ['wrong amount',{amount:'250233'},'Missing'],
 ['wrong evidence',{proof:{evidenceHash:hash(44),deliveredWh:'2188'}},'Missing'],
 ['chain still funded',{trade:trade()},'COMPLETED'],
 ['chain wrong hash',{trade:{...settled(),evidenceHash:hash(1)}},'differs'],
 ['chain wrong energy',{trade:{...settled(),deliveredWh:'2189'}},'differs']]){
 test('settlement rejects '+name,()=>reject(()=>validateEvents(change),err));
}
test('parser separates array/relation/required scalar',()=>{const f=parseModel(fieldSchema,'DeliveryRecord');assert.equal(f.get('trade').relation,true);assert.equal(f.get('tradeId').required,true);assert.equal(f.get('status').required,false);});
test('projection maps exact DB values',()=>{const f=parseModel(fieldSchema,'DeliveryRecord');const out=safeDbProjection(f,{id:good().deliveryId,tradeId,expectedWh:2188,deliveredWh:2188,
  onChainTradeId:'2',sellerId,buyerId,timeSlot:good().timeSlot,status:'CONFIRMED',evidenceHash:hash(8)});
  assert.equal(out.status,'CONFIRMED');assert.equal(out.expectedWh,2188n);assert.ok(out.timeSlot instanceof Date);});
test('projection ignores trade relation',()=>{const fields=parseModel(fieldSchema,'DeliveryRecord');const value={id:good().deliveryId,tradeId,expectedWh:2188,deliveredWh:2188,onChainTradeId:'2',sellerId,buyerId,timeSlot:good().timeSlot,status:'CONFIRMED',evidenceHash:hash(8)};
  assert.equal(Object.hasOwn(safeDbProjection(fields,value),'trade'),false);});
test('unknown required scalar fails before signing',()=>{const fields=parseModel(fieldSchema.replace(' createdAt DateTime', ' requiredSecret String\n createdAt DateTime'),'DeliveryRecord');reject(()=>safeDbProjection(fields,{tradeId,expectedWh:2188,deliveredWh:2188,timeSlot:good().timeSlot,status:'CONFIRMED',evidenceHash:hash(8)}),'required');});
test('missing evidenceHash column fails preflight',()=>{const fields=parseModel(fieldSchema.replace(' evidenceHash String? @db.Char(66)',''),'DeliveryRecord');reject(()=>safeDbProjection(fields,{tradeId,onChainTradeId:'2',sellerId,buyerId,expectedWh:2188,deliveredWh:2188,timeSlot:good().timeSlot,status:'CONFIRMED',evidenceHash:hash(8)}),'capture');});
test('cannot parse missing DeliveryRecord model',()=>reject(()=>parseModel('model Trade {\n id String\n}','DeliveryRecord'),'missing'));
const source=readFileSync(fileURLToPath(new URL('./b16-oracle.mjs',import.meta.url)),'utf8');
test('B16 execution requires explicit TESTNET settlement consent',()=>assert.match(source,/B16_SETTLEMENT_CONFIRM==='I_AUTHORIZE_ONE_ORACLE_SETTLEMENT_ON_HEDERA_TESTNET'/));
test('B16 has one raw broadcast callsite',()=>assert.equal((source.match(/eth_sendRawTransaction/g)??[]).length,1));
test('B16 preflight and simulate never invoke submit',()=>{assert.match(source,/action==='preflight'/);assert.match(source,/action==='simulate'/);});
test('out-of-window simulator uses synthetic identities and temporary non-persisted output',()=>{
 assert.match(source,/onChainTradeId:dryRun\?999999999:Number\(e\.id\)/);
 assert.match(source,/tradeId:dryRun\?randomUUID\(\):e\.tradeId/);
 assert.match(source,/dryRun\?join\(temp,'preview-only-delivery\.json'\):output/);
 assert.match(source,/rmSync\(temp,\{recursive:true,force:true\}\)/);
 assert.match(source,/B16 SIMULATOR DRY RUN PASS/);
});
test('actual oracle send still validates live window and separate consent',()=>{
 assert.match(source,/validateWindow\(sec\(\),e\.trade\.deliveryStart,e\.trade\.deliveryDeadline,\{fresh:true\}\)/);
 assert.match(source,/B16_SETTLEMENT_CONFIRM/);
});

test('B16 never creates or rotates wallets',()=>assert.doesNotMatch(source,/PrivateKey\.generate|wallet\.create|provisionWallet/));
test('B16 encrypted journal before single broadcast',()=>{assert.ok(source.indexOf('encryptSignedTransaction')<source.indexOf("'eth_sendRawTransaction'"));});
test('B16 distinguishes payment synchronization from Oracle broadcast',()=>{assert.match(source,/B16_DB_SYNC_CONFIRM/);assert.match(source,/B16 RECONCILED/);});

test('B16 schema installer patches Match exactly once and appends oracle model',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'b16-schema-test-'));
 try{
  mkdirSync(join(dir,'database'));
  const input=`model Match {\n  id String @id @default(uuid()) @db.Uuid\n}\n`;
  const file=join(dir,'database','schema.prisma');writeFileSync(file,input);
  const script=fileURLToPath(new URL('../../../tools/install-b16-schema.mjs',import.meta.url));
  const run=()=>spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);
  const result=readFileSync(file,'utf8');assert.match(result,/b16OracleIntent B16OracleIntent\?/);assert.match(result,/model B16OracleIntent \{/);
  const second=run();assert.equal(second.status,0,second.stderr);assert.equal(readFileSync(file,'utf8'),result);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
