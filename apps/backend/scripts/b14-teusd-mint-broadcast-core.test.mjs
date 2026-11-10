import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSignedTransaction, canonicalIntent } from './b14-intent-journal-core.mjs';
import {
  parseMintBroadcastArgs, requireMintBroadcastPermission, canonicalMintPlan,
  verifyStoredMint, decodeVerifiedMint, verifyMintNetworkTransaction, verifyMintReceipt,
  observedMintState, requireMintEffect, requireMintSubmitAllowed, assertMintRelayHash,
  decideMintReconciliation, sanitizeMintRpcError,
} from './b14-teusd-mint-broadcast-core.mjs';
const UUID='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const ID='a6ded8be-45b8-4833-99c0-fc9e93771cff';
const ADMIN='0x30f98bbdcd8a334b0b382c0ba521eecdb23592d4';
const BUYER='0x255d93780b72aeb3c29187765d900eae4cf67f31';
const TOKEN='0x9ada96be34382a1554c0be4fb35cc010c05a5c7c';
const EXT=`0x${'c'.repeat(64)}`;
const HASH=`0x${'a'.repeat(64)}`;
const KEY=Buffer.alloc(32,1).toString('base64');
const params=['--match-id',UUID,'--intent-id',ID,'--admin-address',ADMIN];
const plan=canonicalMintPlan({matchId:UUID,externalTradeId:EXT,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232'});
function row(over={}){return {id:ID,matchId:UUID,operation:'MINT_TEUSD',chainId:296,externalTradeId:EXT,signerAddress:ADMIN,targetAddress:TOKEN,payloadSha256:plan.payloadSha256,status:'SIGNED',txHash:HASH,nonce:'3',signedTxCiphertext:'x',signedTxIv:'x',signedTxTag:'x',...over};}
function signed(){return {hash:HASH,nonce:3,maxFeeWei:96_177_620_000_000_000n,tx:{hash:HASH,from:ADMIN,to:TOKEN,chainId:296n,type:0,nonce:3,gasLimit:72314n,gasPrice:1330000000000n,value:0n,data:plan.callData,signature:{v:27}}};}
function net(over={}){const s=signed();return {hash:HASH,from:ADMIN,to:TOKEN,chainId:296n,nonce:3,value:0n,data:s.tx.data,...over};}
function receipt(over={}){return {hash:HASH,from:ADMIN,to:TOKEN,blockNumber:123,status:1,...over};}
function event(over={}){return {contract:'TestEnergyUSD',event:'Transfer',address:TOKEN,args:{from:`0x${'0'.repeat(40)}`,to:BUYER,value:'250232'},...over};}
function submit(over={}){return {row:row(),state:'ABSENT_AT_RPC',adminBalanceWei:1000n*10n**18n,buyerBalanceUnits:'0',signed:signed(),hasMinterRole:true,escrowPaused:false,tradeId:'0',localTrade:null,matchStatus:'SELECTED',otherActiveCount:0,...over};}
const ok=fn=>assert.doesNotThrow(fn);
const bad=fn=>assert.throws(fn);

test('PREVIEW default only',()=>assert.equal(parseMintBroadcastArgs(params).action,'PREVIEW'));
test('SUBMIT explicit',()=>assert.equal(parseMintBroadcastArgs([...params,'--submit']).action,'SUBMIT'));
test('RECONCILE explicit',()=>assert.equal(parseMintBroadcastArgs([...params,'--reconcile']).action,'RECONCILE'));
for(const [name,args] of [
  ['both actions',[...params,'--submit','--reconcile']],['repeated submit',[...params,'--submit','--submit']],
  ['no match',params.slice(2)],['no intent',[...params.slice(0,2),...params.slice(4)]],
  ['no admin',params.slice(0,4)],['repeated field',[...params,'--match-id',UUID]],
  ['unknown flag',[...params,'--force']],['no field value',[...params,'--intent-id']],
  ['bad UUID',['--match-id','x',...params.slice(2)]],
  ['zero admin',[...params.slice(0,5),`0x${'0'.repeat(40)}`]],
  ['unknown --seal',[...params,'--seal']],['unknown --execute',[...params,'--execute']],
  ['no manually provided amount',[...params,'--amount','250232']],
])test(`CLI rejects ${name}`,()=>bad(()=>parseMintBroadcastArgs(args)));
test('address normalized',()=>assert.equal(parseMintBroadcastArgs([...params.slice(0,5),ADMIN.toUpperCase().replace('0X','0x')]).adminAddress,ADMIN));
test('preview requires no permission',()=>ok(()=>requireMintBroadcastPermission({action:'PREVIEW'},{})));
for(const action of ['SUBMIT','RECONCILE'])test(`${action} refuses no confirmation`,()=>bad(()=>requireMintBroadcastPermission({action},{})));
test('submit refuses weak confirmation',()=>bad(()=>requireMintBroadcastPermission({action:'SUBMIT'},{B14_BROADCAST_MINT_CONFIRM:'YES'})));
test('reconcile refuses wrong confirmation',()=>bad(()=>requireMintBroadcastPermission({action:'RECONCILE'},{B14_RECONCILE_MINT_CONFIRM:'YES'})));
test('mint submit exact confirmation',()=>ok(()=>requireMintBroadcastPermission({action:'SUBMIT'},{B14_BROADCAST_MINT_CONFIRM:'SEND_EXACT_SIGNED_250232_TEUSD_MINT'})));
test('mint reconcile exact confirmation',()=>ok(()=>requireMintBroadcastPermission({action:'RECONCILE'},{B14_RECONCILE_MINT_CONFIRM:'RECONCILE_EXISTING_MINT_HASH_ONLY'})));
test('canonical MINT_TEUSD and hash',()=>{assert.equal(plan.operation,'MINT_TEUSD');assert.equal(plan.targetAddress,TOKEN);assert.equal(plan.signerAddress,ADMIN);assert.equal(plan.callData.slice(0,10),'0x40c10f19');assert.equal(plan.callData.length,138);});
test('canonical plan unchanged',()=>assert.equal(canonicalMintPlan({matchId:UUID,externalTradeId:EXT,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232'}).payloadSha256,plan.payloadSha256));
for(const [name,change] of [['amount',{amountUnits:'250233'}],['buyer',{buyerAddress:ADMIN}],['token',{tokenAddress:BUYER}],['admin',{adminAddress:BUYER}]]){
  test(`intent digest changes for ${name}`,()=>{
    const p=canonicalMintPlan({matchId:UUID,externalTradeId:EXT,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232',...change});
    assert.notEqual(p.payloadSha256,plan.payloadSha256);
  });
}
test('mint journal validated',()=>ok(()=>verifyStoredMint(row(),plan,ID)));
for(const [name,field,value] of [
  ['id','id',UUID],['match','matchId',ID],['operation','operation','CREATE_TRADE'],['chain','chainId',1],
  ['external','externalTradeId',HASH],['signer','signerAddress',BUYER],['target','targetAddress',BUYER],
  ['digest','payloadSha256','bad'],['unsigned','status','PLANNED'],['missing tx hash','txHash',null],
  ['bad tx hash','txHash','0x1'],['no ciphertext','signedTxCiphertext',null],
  ['no iv','signedTxIv',null],['no tag','signedTxTag',null],['no nonce','nonce',null],
  ['bad nonce','nonce','-1'],
])test(`mint journal rejects ${name}`,()=>bad(()=>verifyStoredMint(row({[field]:value}),plan,ID)));
for(const state of ['SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'])test(`mint journal accepts ${state} recovery`,()=>ok(()=>verifyStoredMint(row({status:state}),plan,ID)));
test('mint decryption/transaction roundtrip with exact signed envelope',()=>{
  const fakeRaw='0xabcd';const e=encryptSignedTransaction(fakeRaw,KEY,ID);
  const r=row({signedTxCiphertext:e.ciphertext,signedTxIv:e.iv,signedTxTag:e.tag});
  const s=decodeVerifiedMint(r,KEY,plan,BUYER,'250232',raw=>{assert.equal(raw,fakeRaw);return signed().tx;});
  assert.equal(s.hash,HASH);assert.equal(s.nonce,3);assert.equal(s.maxFeeWei,96_177_620_000_000_000n);
});
test('decryption wrong AAD refused',()=>{
  const e=encryptSignedTransaction('0xabcd',KEY,UUID);
  bad(()=>decodeVerifiedMint(row({signedTxCiphertext:e.ciphertext,signedTxIv:e.iv,signedTxTag:e.tag}),KEY,plan,BUYER,'250232',()=>signed().tx));
});
test('decryption wrong key refused',()=>{
  const e=encryptSignedTransaction('0xabcd',KEY,ID);
  bad(()=>decodeVerifiedMint(row({signedTxCiphertext:e.ciphertext,signedTxIv:e.iv,signedTxTag:e.tag}),Buffer.alloc(32,2).toString('base64'),plan,BUYER,'250232',()=>signed().tx));
});
test('decryption invalid signed hash refused',()=>{
  const e=encryptSignedTransaction('0xabcd',KEY,ID);
  bad(()=>decodeVerifiedMint(row({txHash:`0x${'b'.repeat(64)}`,signedTxCiphertext:e.ciphertext,signedTxIv:e.iv,signedTxTag:e.tag}),KEY,plan,BUYER,'250232',()=>signed().tx));
});
test('network mint exactly matches',()=>assert.equal(verifyMintNetworkTransaction(net(),signed()),true));
test('missing network mint means no evidence',()=>assert.equal(verifyMintNetworkTransaction(null,signed()),false));
for(const [name,data] of [
  ['hash',{hash:`0x${'b'.repeat(64)}`}],['sender',{from:BUYER}],['token',{to:BUYER}],
  ['chain',{chainId:1n}],['nonce',{nonce:4}],['native value',{value:1n}],['calldata',{data:'0x'}],
])test(`network mint rejects ${name}`,()=>bad(()=>verifyMintNetworkTransaction(net(data),signed())));
test('no receipt means unknown',()=>assert.equal(verifyMintReceipt(null,signed()),null));
test('matching success receipt accepted',()=>assert.equal(verifyMintReceipt(receipt(),signed()),'CONFIRMED'));
test('matching revert receipt accepted',()=>assert.equal(verifyMintReceipt(receipt({status:0}),signed()),'REVERTED'));
for(const [name,change] of [
  ['hash',{hash:`0x${'b'.repeat(64)}`}],['sender',{from:BUYER}],['contract',{to:BUYER}],
  ['missing block',{blockNumber:null}],['bad status',{status:2}],
])test(`receipt rejects ${name}`,()=>bad(()=>verifyMintReceipt(receipt(change),signed())));
test('state CONFIRMED with receipt',()=>assert.equal(observedMintState({receipt:receipt(),networkTx:net(),nonceLatest:4,noncePending:4},signed()),'CONFIRMED'));
test('state REVERTED with reverted receipt',()=>assert.equal(observedMintState({receipt:receipt({status:0}),networkTx:null,nonceLatest:4,noncePending:4},signed()),'REVERTED'));
test('state PENDING if transaction seen without receipt',()=>assert.equal(observedMintState({receipt:null,networkTx:net(),nonceLatest:3,noncePending:4},signed()),'PENDING_OR_INDEXING'));
test('state ABSENT if clean matching nonce',()=>assert.equal(observedMintState({receipt:null,networkTx:null,nonceLatest:3,noncePending:3},signed()),'ABSENT_AT_RPC'));
for(const [name,nonceLatest,noncePending] of [['latest advanced',4,4],['pending advanced',3,4]])test(`nonce mismatch ${name}`,()=>assert.equal(observedMintState({receipt:null,networkTx:null,nonceLatest,noncePending},signed()),'NONCE_MISMATCH_UNKNOWN'));
test('exact mint Transfer and balance',()=>ok(()=>requireMintEffect({events:[event()],buyerBalanceUnits:'250232',tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232'})));
for(const [name,ev,balance] of [
  ['missing event',[], '250232'],['wrong sender',[event({args:{from:ADMIN,to:BUYER,value:'250232'}})],'250232'],
  ['wrong buyer',[event({args:{from:`0x${'0'.repeat(40)}`,to:ADMIN,value:'250232'}})],'250232'],
  ['wrong token',[event({address:BUYER})],'250232'],
  ['wrong amount',[event({args:{from:`0x${'0'.repeat(40)}`,to:BUYER,value:'250233'}})],'250232'],
  ['wrong event name',[event({event:'Approval'})],'250232'],
  ['wrong contract name',[event({contract:'EnergyTradingEscrow'})],'250232'],
  ['duplicated exact event',[event(),event()],'250232'],
  ['balance not indexed',[event()],'0'],['extra balance',[event()],'250233'],
])test(`confirmed mint effect rejects ${name}`,()=>bad(()=>requireMintEffect({events:ev,buyerBalanceUnits:balance,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232'})));
test('submit is ready only when all checks pass',()=>ok(()=>requireMintSubmitAllowed(submit())));
for(const [name,mod] of [
  ['journal already submitted',{row:row({status:'SUBMITTED'})}],['journal terminal',{row:row({status:'CONFIRMED'})}],
  ['pending chain',{state:'PENDING_OR_INDEXING'}],['nonce mismatched',{state:'NONCE_MISMATCH_UNKNOWN'}],
  ['already minted',{buyerBalanceUnits:'250232'}],['minter missing',{hasMinterRole:false}],
  ['escrow paused',{escrowPaused:true}],['existing chain trade',{tradeId:'1'}],['local trade',{localTrade:{id:1}}],
  ['match changed',{matchStatus:'TRADE_CREATED'}],['admin queue not empty',{otherActiveCount:1}],
  ['admin below reserve',{adminBalanceWei:1n}],['above gas cap',{signed:{...signed(),maxFeeWei:750_000_000_000_000_001n}}],
  ['above gas limit',{signed:{...signed(),tx:{...signed().tx,gasLimit:600001n}}}],
])test(`submit refuses ${name}`,()=>bad(()=>requireMintSubmitAllowed(submit(mod))));
test('relay exact signed hash',()=>ok(()=>assertMintRelayHash(HASH,HASH)));
for(const [name,hash] of [['missing',null],['wrong',`0x${'b'.repeat(64)}`],['zero',`0x${'0'.repeat(64)}`],['bad','0xabc']])test(`relay rejects ${name}`,()=>bad(()=>assertMintRelayHash(hash,HASH)));
for(const [before,chain,next] of [
  ['SIGNED','CONFIRMED','CONFIRMED'],['SIGNED','REVERTED','REVERTED'],
  ['SIGNED','PENDING_OR_INDEXING','SUBMITTED'],['SIGNED','ABSENT_AT_RPC',null],
  ['SUBMITTED','CONFIRMED','CONFIRMED'],['SUBMITTED','REVERTED','REVERTED'],
  ['SUBMITTED','PENDING_OR_INDEXING',null],['SUBMITTED','ABSENT_AT_RPC','NEEDS_RECONCILIATION'],
  ['SUBMITTED','NONCE_MISMATCH_UNKNOWN','NEEDS_RECONCILIATION'],
  ['NEEDS_RECONCILIATION','CONFIRMED','CONFIRMED'],['NEEDS_RECONCILIATION','PENDING_OR_INDEXING','SUBMITTED'],
  ['NEEDS_RECONCILIATION','ABSENT_AT_RPC',null],['CONFIRMED','CONFIRMED',null],['REVERTED','REVERTED',null],
])test(`reconcile ${before} + ${chain} = ${next}`,()=>assert.equal(decideMintReconciliation(row({status:before}),chain),next));
test('terminal journal conflicts with chain',()=>bad(()=>decideMintReconciliation(row({status:'CONFIRMED'}),'REVERTED')));
test('unsupported persisted state blocked',()=>bad(()=>decideMintReconciliation(row({status:'PLANNED'}),'CONFIRMED')));
test('unsupported chain state blocked',()=>bad(()=>decideMintReconciliation(row(),'UNKNOWN')));
test('sanitized RPC error never leaks raw transaction',()=>{
  const msg=sanitizeMintRpcError({code:'SOME_ERROR',message:'0xSECRET_PVT_MINT'});
  assert.match(msg,/SOME_ERROR/);assert.doesNotMatch(msg,/SECRET/);
});

// Additional static invariants: keep the B5-C executor broadcast-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const executorSource=readFileSync(fileURLToPath(new URL('./b14-teusd-mint-broadcast.mjs',import.meta.url)),'utf8');
test('B5-C does not load the admin private signing key',()=>assert.doesNotMatch(executorSource,/HEDERA_ADMIN_PRIVATE_KEY|new Wallet\(/));
test('B5-C contains no transaction signing method',()=>assert.doesNotMatch(executorSource,/\.signTransaction\s*\(/));
test('B5-C has exactly one raw transaction broadcast site',()=>assert.equal((executorSource.match(/provider\.send\('eth_sendRawTransaction'/g)??[]).length,1));
test('B5-C does not create journal rows',()=>assert.doesNotMatch(executorSource,/b14TransactionIntent\.create\s*\(/));
