import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHbarSealArgs, requireSealPermission, verifyStagedIntent, requireCleanSignerQueue,
  requireNonce, computeSafeGasQuote, makeUnsignedTopup, verifySignedEnvelope,
} from './b14-hbar-seal-core.mjs';
import { canonicalIntent } from './b14-intent-journal-core.mjs';

const match = '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const intent = '38065271-3ca3-4e18-b3b0-1fce7fb853d6';
const signer = '0xD74a6786587A2a936cFb059fec998Ad6DB300F37';
const buyer = '0x255d93780b72aeb3c29187765d900eae4cf67f31';
const extId = '0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07';
const argList = ['--match-id', match, '--intent-id', intent, '--operator-address', signer, '--hbar', '0.2'];
const plan = canonicalIntent({matchId:match,operation:'FUND_BUYER_HBAR',externalTradeId:extId,signerAddress:signer,targetAddress:buyer,valueWei:'200000000000000000',callData:'0x'});
const row = {id:intent,matchId:match,operation:'FUND_BUYER_HBAR',externalTradeId:extId,chainId:296,signerAddress:signer.toLowerCase(),targetAddress:buyer.toLowerCase(),payloadSha256:plan.payloadSha256,status:'PLANNED',nonce:null,txHash:null,signedTxCiphertext:null,signedTxIv:null,signedTxTag:null};
const balance='1000000000000000000000';
const quoteInput = {estimateGas: 61_000n, gasPriceWei: 500_000_000_000n, senderBalanceWei:balance,valueWei:plan.valueWei};
const signedBase={hash:'0x'+'a'.repeat(64),from:signer,chainId:296,type:0,nonce:4,to:buyer,value:200000000000000000n,gasLimit:73200n,gasPrice:500000000000n,data:'0x'};
const envelope=makeUnsignedTopup({chainId:296,signerAddress:signer,targetAddress:buyer,valueWei:plan.valueWei,nonce:4,gasLimit:73200n,gasPriceWei:500000000000n});

test('preview is default; exact staged UUID',()=>{
 const a=parseHbarSealArgs(argList); assert.equal(a.seal,false);assert.equal(a.intentId,intent);assert.equal(a.valueWei,plan.valueWei);assert.equal(a.operatorAddress,signer.toLowerCase());
});
test('explicit seal flag accepted',()=>assert.equal(parseHbarSealArgs([...argList,'--seal']).seal,true));
test('never accept broadcast switches',()=>{
 for(const flag of ['--broadcast','--execute','--submit','--send','--retry'])assert.throws(()=>parseHbarSealArgs([...argList,flag]));
});
test('refuse missing required input',()=>assert.throws(()=>parseHbarSealArgs(argList.slice(0,-2))));
test('refuse duplicate flags',()=>assert.throws(()=>parseHbarSealArgs([...argList,'--hbar','0.2'])));
test('refuse malformed match UUID',()=>assert.throws(()=>parseHbarSealArgs(['--match-id','bad',...argList.slice(2)])));
test('refuse malformed intent UUID',()=>assert.throws(()=>parseHbarSealArgs([argList[0],match,'--intent-id','bad',...argList.slice(4)])));
test('refuse malformed public operator',()=>assert.throws(()=>parseHbarSealArgs([...argList.slice(0,4), '--operator-address','bad','--hbar','0.2'])));
test('reject HBAR topup outside 0.1-1 range',()=>assert.throws(()=>parseHbarSealArgs([...argList.slice(0,-1),'1.1'])));
test('seal requires explicit confirmation',()=>assert.throws(()=>requireSealPermission({seal:true},{})));
test('seal requires exact phrase',()=>assert.throws(()=>requireSealPermission({seal:true},{B14_SEAL_INTENT_CONFIRM:'YES'})));
test('preview does not require signing consent',()=>assert.equal(requireSealPermission({seal:false},{}),false));
test('seal confirmation permits local signing only',()=>assert.equal(requireSealPermission({seal:true},{B14_SEAL_INTENT_CONFIRM:'YES_SIGN_BUT_DO_NOT_SEND'}),true));
test('staged intent validates exactly',()=>assert.equal(verifyStagedIntent(row,plan,intent),true));
test('refuses incorrect intent id',()=>assert.throws(()=>verifyStagedIntent(row,plan,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')));
test('refuses altered immutable payload',()=>assert.throws(()=>verifyStagedIntent({...row,payloadSha256:'b'.repeat(64)},plan,intent)));
test('refuses altered external trade id',()=>assert.throws(()=>verifyStagedIntent({...row,externalTradeId:'0x'+'b'.repeat(64)},plan,intent)));
test('refuses non-PLANNED intent',()=>assert.throws(()=>verifyStagedIntent({...row,status:'SIGNED'},plan,intent)));
test('refuses partially filled signature row',()=>assert.throws(()=>verifyStagedIntent({...row,txHash:'0x'+'a'.repeat(64)},plan,intent)));
test('no pending other local intents',()=>assert.equal(requireCleanSignerQueue([{id:intent,status:'PLANNED'}],intent),true));
test('another SIGNED intent blocks signer',()=>assert.throws(()=>requireCleanSignerQueue([{id:'other',status:'SIGNED'}],intent)));
test('another SUBMITTED intent blocks signer',()=>assert.throws(()=>requireCleanSignerQueue([{id:'other',status:'SUBMITTED'}],intent)));
test('another uncertain intent blocks signer',()=>assert.throws(()=>requireCleanSignerQueue([{id:'other',status:'NEEDS_RECONCILIATION'}],intent)));
test('past CONFIRMED rows do not block a new nonce',()=>assert.equal(requireCleanSignerQueue([{id:'other',status:'CONFIRMED'}],intent),true));
test('matching pending and latest nonce passes',()=>assert.equal(requireNonce(4,4),4));
test('pending nonce mismatch is unsafe',()=>assert.throws(()=>requireNonce(4,5)));
test('negative or fractional nonce is invalid',()=>{assert.throws(()=>requireNonce(-1,-1));assert.throws(()=>requireNonce(1.5,1.5));});
test('nonce above safe JS bound rejected',()=>assert.throws(()=>requireNonce('9007199254740992','9007199254740992')));
test('gas quote adds 20% margin and caps cost',()=>{
 const q=computeSafeGasQuote(quoteInput);assert.equal(q.gasLimit,73_200n);assert.equal(q.maxFeeWei,36_600_000_000_000_000n);
});
test('gas estimate zero rejected',()=>assert.throws(()=>computeSafeGasQuote({...quoteInput,estimateGas:0})));
test('gasPrice zero rejected',()=>assert.throws(()=>computeSafeGasQuote({...quoteInput,gasPriceWei:0})));
test('gas limit above 250k rejected',()=>assert.throws(()=>computeSafeGasQuote({...quoteInput,estimateGas:220_000})));
test('fee above 0.1 HBAR rejected',()=>assert.throws(()=>computeSafeGasQuote({...quoteInput,gasPriceWei:'2000000000000'})));
test('operator retains 1 HBAR reserve',()=>assert.throws(()=>computeSafeGasQuote({...quoteInput,senderBalanceWei:'1200000000000000000'})));
test('unsigned transfer uses Hedera chain 296 and legacy gas',()=>{
 assert.equal(envelope.chainId,296);assert.equal(envelope.type,0);assert.equal(envelope.to,buyer.toLowerCase());assert.equal(envelope.data,'0x');assert.equal(envelope.nonce,4);
});
test('unsigned transfer refuses wrong chain',()=>assert.throws(()=>makeUnsignedTopup({chainId:295,signerAddress:signer,targetAddress:buyer,valueWei:plan.valueWei,nonce:4,gasLimit:73200,gasPriceWei:500000000000n})));
test('unsigned transfer refuses self-pay',()=>assert.throws(()=>makeUnsignedTopup({chainId:296,signerAddress:signer,targetAddress:signer,valueWei:plan.valueWei,nonce:4,gasLimit:73200,gasPriceWei:500000000000n})));
test('signed envelope exactly matches planned transfer',()=>assert.equal(verifySignedEnvelope(signedBase,envelope,signer),signedBase.hash));
test('signed envelope cannot redirect buyer',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,to:signer},envelope,signer)));
test('signed envelope cannot increase value',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,value:signedBase.value+1n},envelope,signer)));
test('signed envelope cannot alter chain',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,chainId:295},envelope,signer)));
test('signed envelope cannot alter nonce',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,nonce:5},envelope,signer)));
test('signed envelope cannot alter gas',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,gasPrice:1n},envelope,signer)));
test('signed envelope cannot contain calldata',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,data:'0x1234'},envelope,signer)));
test('signed envelope cannot be from another signer',()=>assert.throws(()=>verifySignedEnvelope({...signedBase,from:buyer},envelope,signer)));

test('B3 executable contains no broadcast method call', async () => {
 const { readFileSync } = await import('node:fs');
 const { fileURLToPath } = await import('node:url');
 const code = readFileSync(fileURLToPath(new URL('./b14-hbar-seal.mjs', import.meta.url)), 'utf8');
 assert.doesNotMatch(code, /\b(?:sendTransaction|broadcastTransaction|sendRawTransaction)\s*\(/);
});
