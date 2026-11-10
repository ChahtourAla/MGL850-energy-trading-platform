import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMintSealArgs,requireMintSealPermission,verifyPlannedMintJournal,
  requireCleanMintSignerQueue,requireMintNonce,safeMintGasQuote,
  makeUnsignedMint,verifySignedMintEnvelope,MINT_MAX_GAS_LIMIT,MINT_MAX_FEE_WEI,
} from './b14-teusd-mint-seal-core.mjs';
import { canonicalIntent } from './b14-intent-journal-core.mjs';
import { exactMintCalldata } from './b14-teusd-mint-core.mjs';
import { readFileSync } from 'node:fs';

const MATCH='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const ID='a6ded8be-45b8-4833-99c0-fc9e93771cff';
const ADMIN='0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4';
const BUYER='0x255d93780b72aeb3c29187765d900eae4cf67f31';
const TOKEN='0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c';
const EXT='0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07';
const CALL=exactMintCalldata(BUYER,'250232');
const plan=canonicalIntent({matchId:MATCH,operation:'MINT_TEUSD',externalTradeId:EXT,
  signerAddress:ADMIN,targetAddress:TOKEN,valueWei:'0',callData:CALL});
const row=()=>({id:ID,matchId:MATCH,externalTradeId:EXT,chainId:296,operation:'MINT_TEUSD',
  signerAddress:ADMIN.toLowerCase(),targetAddress:TOKEN.toLowerCase(),
  payloadSha256:plan.payloadSha256,status:'PLANNED',txHash:null,nonce:null,
  signedTxCiphertext:null,signedTxIv:null,signedTxTag:null,confirmedAt:null});
const baseArgs=['--match-id',MATCH,'--intent-id',ID,'--admin-address',ADMIN];
const validUnsigned=()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,
  buyerAddress:BUYER,amountUnits:'250232',callData:CALL,nonce:5,gasLimit:180000n,gasPriceWei:1000000000000n});
const validSigned=()=>({...validUnsigned(),from:ADMIN,hash:'0x'+'f'.repeat(64)});
const fails=(fn,regex=/./)=>assert.throws(fn,regex);

test('preview is default',()=>assert.equal(parseMintSealArgs(baseArgs).seal,false));
test('--seal explicitly supported',()=>assert.equal(parseMintSealArgs([...baseArgs,'--seal']).seal,true));
test('missing match id refused',()=>fails(()=>parseMintSealArgs(baseArgs.slice(2))));
test('missing intent id refused',()=>fails(()=>parseMintSealArgs(baseArgs.slice(0,2).concat(baseArgs.slice(4)))));
test('missing admin refused',()=>fails(()=>parseMintSealArgs(baseArgs.slice(0,4))));
test('bad match uuid refused',()=>fails(()=>parseMintSealArgs(['--match-id','oops',...baseArgs.slice(2)])));
test('bad intent uuid refused',()=>fails(()=>parseMintSealArgs([...baseArgs.slice(0,3),'no',...baseArgs.slice(4)])));
test('zero admin refused',()=>fails(()=>parseMintSealArgs([...baseArgs.slice(0,5),'0x'+'0'.repeat(40)])));
test('duplicate argument refused',()=>fails(()=>parseMintSealArgs([...baseArgs,'--intent-id',ID])));
test('duplicate --seal refused',()=>fails(()=>parseMintSealArgs([...baseArgs,'--seal','--seal'])));
test('unknown --submit refused',()=>fails(()=>parseMintSealArgs([...baseArgs,'--submit'])));
test('unknown --broadcast refused',()=>fails(()=>parseMintSealArgs([...baseArgs,'--broadcast'])));
test('unknown --execute refused',()=>fails(()=>parseMintSealArgs([...baseArgs,'--execute'])));
test('mint amount cannot be overridden by CLI',()=>fails(()=>parseMintSealArgs([...baseArgs,'--amount','9'])));
test('normalizes admin address',()=>assert.equal(parseMintSealArgs(baseArgs).adminAddress,ADMIN.toLowerCase()));
test('preview needs no confirmation',()=>assert.equal(requireMintSealPermission({seal:false},{}),false));
test('seal fails without consent',()=>fails(()=>requireMintSealPermission({seal:true},{})));
test('seal fails with weak consent',()=>fails(()=>requireMintSealPermission({seal:true},{B14_SEAL_MINT_CONFIRM:'YES'})));
test('seal requires exact mint-specific phrase',()=>assert.equal(requireMintSealPermission({seal:true},{B14_SEAL_MINT_CONFIRM:'YES_SIGN_EXACT_TEUSD_MINT_DO_NOT_SEND'}),true));
test('correct staged mint row accepted',()=>assert.equal(verifyPlannedMintJournal(row(),plan,ID),true));
test('wrong intent ID refused',()=>fails(()=>verifyPlannedMintJournal(row(),plan,'e0000000-0000-4000-8000-000000000000')));
test('wrong operation refused',()=>fails(()=>verifyPlannedMintJournal({...row(),operation:'FUND_BUYER_HBAR'},plan,ID)));
test('wrong externalTradeId refused',()=>fails(()=>verifyPlannedMintJournal({...row(),externalTradeId:'0x'+'a'.repeat(64)},plan,ID)));
test('changed digest refused',()=>fails(()=>verifyPlannedMintJournal({...row(),payloadSha256:'a'.repeat(64)},plan,ID)));
test('changed signer refused',()=>fails(()=>verifyPlannedMintJournal({...row(),signerAddress:BUYER},plan,ID)));
test('wrong target contract refused',()=>fails(()=>verifyPlannedMintJournal({...row(),targetAddress:BUYER},plan,ID)));
test('incorrect chain ID refused',()=>fails(()=>verifyPlannedMintJournal({...row(),chainId:295},plan,ID)));
test('SIGNED row cannot be sealed again',()=>fails(()=>verifyPlannedMintJournal({...row(),status:'SIGNED'},plan,ID)));
test('no existing tx hash in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),txHash:'0x'+'b'.repeat(64)},plan,ID)));
test('no existing nonce in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),nonce:'0'},plan,ID)));
test('no existing ciphertext in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),signedTxCiphertext:'encrypted'},plan,ID)));
test('no existing iv in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),signedTxIv:'iv'},plan,ID)));
test('no existing auth tag in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),signedTxTag:'tag'},plan,ID)));
test('no confirmation timestamp in PLANNED',()=>fails(()=>verifyPlannedMintJournal({...row(),confirmedAt:new Date()},plan,ID)));
test('empty admin queue is safe',()=>assert.equal(requireCleanMintSignerQueue([],ID),true));
test('confirmed old admin journal does not block',()=>assert.equal(requireCleanMintSignerQueue([{id:'old',status:'CONFIRMED'}],ID),true));
test('other signed admin transaction blocks mint',()=>fails(()=>requireCleanMintSignerQueue([{id:'old',status:'SIGNED'}],ID)));
test('other submitted admin transaction blocks mint',()=>fails(()=>requireCleanMintSignerQueue([{id:'old',status:'SUBMITTED'}],ID)));
test('other uncertain admin transaction blocks mint',()=>fails(()=>requireCleanMintSignerQueue([{id:'old',status:'NEEDS_RECONCILIATION'}],ID)));
test('same mint intent ignored in queue helper',()=>assert.equal(requireCleanMintSignerQueue([{id:ID,status:'SIGNED'}],ID),true));
test('matching latest and pending admin nonce accepted',()=>assert.equal(requireMintNonce(5,5),5));
test('pending admin nonce differs is blocked',()=>fails(()=>requireMintNonce(5,6)));
test('nonce negative blocked',()=>fails(()=>requireMintNonce(-1,-1)));
test('fractional nonce blocked',()=>fails(()=>requireMintNonce(1.1,1.1)));
test('unsafe-large nonce blocked',()=>fails(()=>requireMintNonce('9007199254740992','9007199254740992')));
test('mint fee quote adds 20% headroom',()=>{
  const x=safeMintGasQuote({estimatedGas:100000n,gasPriceWei:1000000000000n,adminBalanceWei:100000000000000000000n});
  assert.equal(x.gasLimit,120000n);assert.equal(x.maxFeeWei,120000000000000000n);
});
test('fee quote rounds upwards',()=>assert.equal(safeMintGasQuote({estimatedGas:21n,gasPriceWei:1n,adminBalanceWei:10000000000000000000n}).gasLimit,26n));
test('mint gas estimate zero rejected',()=>fails(()=>safeMintGasQuote({estimatedGas:0,gasPriceWei:1,adminBalanceWei:'10000000000000000000'})));
test('mint gas price zero rejected',()=>fails(()=>safeMintGasQuote({estimatedGas:2,gasPriceWei:0,adminBalanceWei:'10000000000000000000'})));
test('mint gas exceeds 600k rejected',()=>fails(()=>safeMintGasQuote({estimatedGas:MINT_MAX_GAS_LIMIT,gasPriceWei:1,adminBalanceWei:'10000000000000000000'})));
test('mint max fee over 0.75 HBAR rejected',()=>fails(()=>safeMintGasQuote({estimatedGas:300000n,gasPriceWei:3000000000000n,adminBalanceWei:'10000000000000000000'})));
test('admin reserve below 1 HBAR rejected',()=>fails(()=>safeMintGasQuote({estimatedGas:100000n,gasPriceWei:1000000000000n,adminBalanceWei:1100000000000000000n})));
test('mint fee policy constants',()=>{assert.equal(MINT_MAX_GAS_LIMIT,600000n);assert.equal(MINT_MAX_FEE_WEI,750000000000000000n)});
test('unsigned mint has chain 296, type 0, zero HBAR',()=>{
  const x=validUnsigned();assert.equal(x.chainId,296);assert.equal(x.type,0);assert.equal(x.value,0n);assert.equal(x.to,TOKEN.toLowerCase());
});
test('unsigned mint pins exact buyer and amount',()=>assert.equal(validUnsigned().data,CALL));
test('unsigned mint refuses wrong chain',()=>fails(()=>makeUnsignedMint({...validUnsigned(),chainId:1,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232',callData:CALL})));
test('unsigned mint refuses redirected recipient',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:ADMIN,amountUnits:'250232',callData:CALL,nonce:5,gasLimit:100000n,gasPriceWei:1n})));
test('unsigned mint refuses altered amount',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250233',callData:CALL,nonce:5,gasLimit:100000n,gasPriceWei:1n})));
test('unsigned mint refuses altered calldata',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232',callData:'0x1234',nonce:5,gasLimit:100000n,gasPriceWei:1n})));
test('unsigned mint refuses gas above cap',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232',callData:CALL,nonce:5,gasLimit:700000n,gasPriceWei:1n})));
test('unsigned mint refuses fee above cap',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:TOKEN,buyerAddress:BUYER,amountUnits:'250232',callData:CALL,nonce:5,gasLimit:200000n,gasPriceWei:4000000000000n})));
test('unsigned mint refuses self-signing target',()=>fails(()=>makeUnsignedMint({chainId:296,adminAddress:ADMIN,tokenAddress:ADMIN,buyerAddress:BUYER,amountUnits:'250232',callData:CALL,nonce:5,gasLimit:100000n,gasPriceWei:1n})));
test('signed mint with unchanged envelope accepted',()=>assert.equal(verifySignedMintEnvelope(validSigned(),validUnsigned(),ADMIN),'0x'+'f'.repeat(64)));
test('signed mint wrong sender rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),from:BUYER},validUnsigned(),ADMIN)));
test('signed mint changed target rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),to:BUYER},validUnsigned(),ADMIN)));
test('signed mint changed recipient calldata rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),data:exactMintCalldata(ADMIN,'250232')},validUnsigned(),ADMIN)));
test('signed mint changed token amount rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),data:exactMintCalldata(BUYER,'250233')},validUnsigned(),ADMIN)));
test('signed mint changed chain rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),chainId:1},validUnsigned(),ADMIN)));
test('signed mint wrong transaction type rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),type:2},validUnsigned(),ADMIN)));
test('signed mint changed nonce rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),nonce:4},validUnsigned(),ADMIN)));
test('signed mint changed gas limit rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),gasLimit:210000n},validUnsigned(),ADMIN)));
test('signed mint changed gas price rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),gasPrice:2000000000000n},validUnsigned(),ADMIN)));
test('signed mint nonzero native value rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),value:1n},validUnsigned(),ADMIN)));
test('signed mint hash missing rejected',()=>fails(()=>verifySignedMintEnvelope({...validSigned(),hash:null},validUnsigned(),ADMIN)));
test('executable has no RPC write or broadcast method',()=>{
  const source=readFileSync(new URL('./b14-teusd-mint-seal.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:eth_sendRawTransaction|sendTransaction|broadcastTransaction)\s*\(/);
  assert.doesNotMatch(source,/provider\.send\(\s*['"]eth_sendRawTransaction/);
});
