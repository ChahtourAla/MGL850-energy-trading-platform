import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {canonicalIntent,encryptSignedTransaction} from './b14-intent-journal-core.mjs';
import {
 parseBroadcastArgs,requireBroadcastPermission,expectedTopupIntent,verifyJournalForB4,
 decodeVerifiedSigned,verifyNetworkTx,receiptOutcome,observedState,
 assertSubmitAllowed,assertRelayHash,decideReconciliation,sanitizeBroadcastError,
} from './b14-hbar-broadcast-core.mjs';

const matchId='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const intentId='38065271-3ca3-4e18-b3b0-1fce7fb853d6';
const operator='0xd74a6786587a2a936cfb059fec998ad6db300f37';
const buyer='0x255d93780b72aeb3c29187765d900eae4cf67f31';
const externalTradeId='0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07';
const txHash='0x'+'a'.repeat(64);
const argv=['--match-id',matchId,'--intent-id',intentId,'--operator-address',operator,'--hbar','0.2'];
const args=parseBroadcastArgs(argv);
const plan=expectedTopupIntent(args,externalTradeId,buyer);
const key=randomBytes(32).toString('base64');
const bundle=encryptSignedTransaction('0x1234',key,intentId);
const row={id:intentId,matchId,operation:'FUND_BUYER_HBAR',chainId:296,externalTradeId,
  payloadSha256:plan.payloadSha256,signerAddress:operator,targetAddress:buyer,status:'SIGNED',
  nonce:'3',txHash,signedTxCiphertext:bundle.ciphertext,signedTxIv:bundle.iv,signedTxTag:bundle.tag};
const tx={signature:{},hash:txHash,from:operator,to:buyer,chainId:296,type:0,data:'0x',value:200000000000000000n,
 nonce:3,gasLimit:28764n,gasPrice:1320000000000n};
const decoder=raw=>{assert.equal(raw,'0x1234');return {...tx}};
const signed=decodeVerifiedSigned(row,key,plan,decoder);
const receipt={hash:txHash,from:operator,to:buyer,blockNumber:12,status:1};
const networkTx={hash:txHash,from:operator,to:buyer,nonce:3,value:tx.value,data:'0x'};
const obs={receipt:null,networkTx:null,nonceLatest:3,noncePending:3};
const fail=(fn,regex)=>assert.throws(fn,regex);

test('default action is read-only PREVIEW',()=>assert.equal(args.action,'PREVIEW'));
test('SUBMIT supported',()=>assert.equal(parseBroadcastArgs([...argv,'--submit']).action,'SUBMIT'));
test('RECONCILE supported',()=>assert.equal(parseBroadcastArgs([...argv,'--reconcile']).action,'RECONCILE'));
test('multiple actions refused',()=>fail(()=>parseBroadcastArgs([...argv,'--submit','--reconcile']),/one/));
test('duplicate flags refused',()=>fail(()=>parseBroadcastArgs([...argv,'--hbar','0.2']),/repeated/));
test('unknown flags refused',()=>fail(()=>parseBroadcastArgs([...argv,'--execute']),/Unknown/));
test('missing required args refused',()=>fail(()=>parseBroadcastArgs(argv.slice(0,-2)),/Missing/));
test('wrong match uuid refused',()=>fail(()=>parseBroadcastArgs(['--match-id','x',...argv.slice(2)]),/UUID/));
test('wrong intent uuid refused',()=>fail(()=>parseBroadcastArgs([...argv.slice(0,3),'x',...argv.slice(4)]),/UUID/));
test('malformed address refused',()=>fail(()=>parseBroadcastArgs([...argv.slice(0,5),'x',...argv.slice(6)]),/address/));
test('amount above 1 HBAR refused',()=>fail(()=>parseBroadcastArgs([...argv.slice(0,-1),'2']),/decimal|between/));
test('amount with 9 decimals refused',()=>fail(()=>parseBroadcastArgs([...argv.slice(0,-1),'0.200000001']),/decimal/));
test('preview needs no consent',()=>assert.equal(requireBroadcastPermission(args,{}),true));
test('SUBMIT needs exact confirmation',()=>fail(()=>requireBroadcastPermission({...args,action:'SUBMIT'},{}),/requires/));
test('SUBMIT rejects weak confirmation',()=>fail(()=>requireBroadcastPermission({...args,action:'SUBMIT'},{B14_BROADCAST_CONFIRM:'YES'}),/requires/));
test('SUBMIT exact phrase permitted',()=>assert.equal(requireBroadcastPermission({...args,action:'SUBMIT'},{B14_BROADCAST_CONFIRM:'SEND_EXACT_SIGNED_0_2_TESTNET_HBAR'}),true));
test('reconcile requires different confirmation',()=>fail(()=>requireBroadcastPermission({...args,action:'RECONCILE'},{B14_BROADCAST_CONFIRM:'SEND_EXACT_SIGNED_0_2_TESTNET_HBAR'}),/requires/));
test('reconcile exact phrase permitted',()=>assert.equal(requireBroadcastPermission({...args,action:'RECONCILE'},{B14_RECONCILE_CONFIRM:'RECONCILE_EXISTING_HASH_ONLY'}),true));
test('canonical digest stable',()=>assert.equal(plan.payloadSha256,expectedTopupIntent(args,externalTradeId,buyer).payloadSha256));
test('wrong buyer changes digest',()=>assert.notEqual(plan.payloadSha256,expectedTopupIntent(args,externalTradeId,'0x'+'f'.repeat(40)).payloadSha256));
test('signed journal accepted',()=>assert.equal(verifyJournalForB4(row,plan,args),true));
for(const [label,patch] of [
 ['wrong intent id',{id:'11111111-1111-4111-8111-111111111111'}],['wrong chain',{chainId:295}],
 ['wrong match',{matchId:'11111111-1111-4111-8111-111111111111'}],['wrong digest',{payloadSha256:'a'.repeat(64)}],
 ['wrong operation',{operation:'MINT_TEUSD'}],['wrong signer',{signerAddress:buyer}],
 ['wrong target',{targetAddress:operator}],['wrong external id',{externalTradeId:'0x'+'a'.repeat(64)}],
 ['PLANNED forbidden',{status:'PLANNED'}],['hash missing',{txHash:null}],['nonce missing',{nonce:null}],
 ['encrypted bytes missing',{signedTxCiphertext:null}],['IV missing',{signedTxIv:null}],['tag missing',{signedTxTag:null}],
]) test(`journal rejects ${label}`,()=>fail(()=>verifyJournalForB4({...row,...patch},plan,args),/Signed|B14|signed|material|requires/));
test('sealed bytes are decrypted and checked',()=>assert.equal(signed.hash,txHash));
test('bad decryption key rejected',()=>fail(()=>decodeVerifiedSigned(row,randomBytes(32).toString('base64'),plan,decoder),/authenticate|decrypt|Unsupported/));
test('transaction decoder must be provided',()=>fail(()=>decodeVerifiedSigned(row,key,plan,null),/decoder/));
for(const [label,patch] of [
 ['hash',{hash:'0x'+'b'.repeat(64)}],['signer',{from:buyer}],['buyer',{to:operator}],
 ['chain',{chainId:295}],['type',{type:2}],['calldata',{data:'0x1234'}],
 ['amount',{value:200000000000000001n}],['nonce',{nonce:4}],['gas too large',{gasLimit:300000n}],
 ['gas below minimum',{gasLimit:1n}],['gas price zero',{gasPrice:0n}],['fee cap',{gasPrice:4000000000000n}],
 ['unsigned',{signature:null}],
]) test(`signed envelope rejects wrong ${label}`,()=>fail(()=>decodeVerifiedSigned(row,key,plan,()=>({...tx,...patch})),/does not match/));
test('RPC transaction matching raw accepted',()=>assert.equal(verifyNetworkTx(networkTx,signed),true));
test('missing network transaction is false',()=>assert.equal(verifyNetworkTx(null,signed),false));
for(const [label,patch] of [['hash',{hash:'0x'+'b'.repeat(64)}],['sender',{from:buyer}],['recipient',{to:operator}],['nonce',{nonce:4}],['amount',{value:0n}],['calldata',{data:'0x1234'}]])
 test(`RPC transaction ${label} mismatch refused`,()=>fail(()=>verifyNetworkTx({...networkTx,...patch},signed),/differs/));
test('empty receipt is unknown not failed',()=>assert.equal(receiptOutcome(null,signed),null));
test('successful receipt yields CONFIRMED',()=>assert.equal(receiptOutcome(receipt,signed),'CONFIRMED'));
test('reverted receipt yields REVERTED',()=>assert.equal(receiptOutcome({...receipt,status:0},signed),'REVERTED'));
for(const [label,patch] of [['wrong hash',{hash:'0x'+'b'.repeat(64)}],['wrong sender',{from:buyer}],['wrong recipient',{to:operator}],['missing block',{blockNumber:null}],['nonfinal status',{status:null}]])
 test(`receipt rejects ${label}`,()=>fail(()=>receiptOutcome({...receipt,...patch},signed),/receipt/));
test('unknown hash and clean nonce is ABSENT_AT_RPC',()=>assert.equal(observedState(obs,signed),'ABSENT_AT_RPC'));
test('network transaction without receipt is pending',()=>assert.equal(observedState({...obs,networkTx},signed),'PENDING_OR_INDEXING'));
test('receipt success takes precedence',()=>assert.equal(observedState({...obs,receipt},signed),'CONFIRMED'));
test('receipt revert takes precedence',()=>assert.equal(observedState({...obs,receipt:{...receipt,status:0}},signed),'REVERTED'));
test('unexpected advanced nonce produces unknown',()=>assert.equal(observedState({...obs,nonceLatest:4},signed),'NONCE_MISMATCH_UNKNOWN'));
test('pending-only nonce mismatch produces unknown',()=>assert.equal(observedState({...obs,noncePending:4},signed),'NONCE_MISMATCH_UNKNOWN'));
test('submit allowed only clean, exact SIGNED with enough reserve',()=>assert.equal(assertSubmitAllowed(row,'ABSENT_AT_RPC',2_000_000_000_000_000_000n,signed),true));
test('submit rejected for SUBMITTED journal',()=>fail(()=>assertSubmitAllowed({...row,status:'SUBMITTED'},'ABSENT_AT_RPC',2_000_000_000_000_000_000n,signed),/SIGNED/));
test('submit rejected for confirmed transaction',()=>fail(()=>assertSubmitAllowed(row,'CONFIRMED',2_000_000_000_000_000_000n,signed),/CONFIRMED/));
test('submit rejected if operator balance below reserve',()=>fail(()=>assertSubmitAllowed(row,'ABSENT_AT_RPC',1_000_000_000_000_000_000n,signed),/reserve/));
test('relay expected hash accepted',()=>assert.equal(assertRelayHash(txHash,txHash),true));
test('relay zero hash refused',()=>fail(()=>assertRelayHash('0x'+'0'.repeat(64),txHash),/hash/));
test('relay wrong hash refused',()=>fail(()=>assertRelayHash('0x'+'b'.repeat(64),txHash),/hash/));
test('relay missing hash refused',()=>fail(()=>assertRelayHash(null,txHash),/hash/));
test('SIGNED known success reconciles',()=>assert.equal(decideReconciliation(row,'CONFIRMED'),'CONFIRMED'));
test('SIGNED no receipt remains SIGNED',()=>assert.equal(decideReconciliation(row,'ABSENT_AT_RPC'),null));
test('SIGNED seen pending becomes SUBMITTED',()=>assert.equal(decideReconciliation(row,'PENDING_OR_INDEXING'),'SUBMITTED'));
test('SUBMITTED successful becomes CONFIRMED',()=>assert.equal(decideReconciliation({...row,status:'SUBMITTED'},'CONFIRMED'),'CONFIRMED'));
test('SUBMITTED reverted becomes REVERTED',()=>assert.equal(decideReconciliation({...row,status:'SUBMITTED'},'REVERTED'),'REVERTED'));
test('SUBMITTED absent becomes NEEDS_RECONCILIATION',()=>assert.equal(decideReconciliation({...row,status:'SUBMITTED'},'ABSENT_AT_RPC'),'NEEDS_RECONCILIATION'));
test('NEEDS_RECONCILIATION successful becomes CONFIRMED',()=>assert.equal(decideReconciliation({...row,status:'NEEDS_RECONCILIATION'},'CONFIRMED'),'CONFIRMED'));
test('NEEDS_RECONCILIATION stays blocked if absent',()=>assert.equal(decideReconciliation({...row,status:'NEEDS_RECONCILIATION'},'ABSENT_AT_RPC'),null));
test('CONFIRMED terminal stays unchanged',()=>assert.equal(decideReconciliation({...row,status:'CONFIRMED'},'CONFIRMED'),null));
test('CONFIRMED cannot revert',()=>fail(()=>decideReconciliation({...row,status:'CONFIRMED'},'REVERTED'),/conflicts/));
test('reconciliation rejects unsupported status',()=>fail(()=>decideReconciliation({...row,status:'PLANNED'},'CONFIRMED'),/Unexpected/));
test('sanitized RPC errors never contain raw transaction bytes',()=>assert.equal(sanitizeBroadcastError({message:'raw 0x1234',code:'CALL_EXCEPTION'}).includes('0x1234'),false));
