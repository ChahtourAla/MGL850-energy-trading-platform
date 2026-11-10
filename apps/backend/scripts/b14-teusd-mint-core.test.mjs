import test from 'node:test';
import assert from 'node:assert/strict';
import {
 parseMintArgs,requireMintStagePermission,exactMintCalldata,requireConfirmedBuyerHbar,
 confirmBuyerHbarOnChain,disallowPrematureOperations,prepareMintIntent,existingMintDisposition,
 displayTeusd,MINT_SELECTOR,
} from './b14-teusd-mint-core.mjs';
import {canonicalIntent} from './b14-intent-journal-core.mjs';

const matchId='60bd8ca9-bb7d-534f-8564-468e4a5f0b3a';
const externalTradeId='0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07';
const admin='0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4';
const operator='0xD74a6786587A2a936cFb059fec998Ad6DB300F37';
const buyer='0x255d93780b72aeb3c29187765d900eae4cf67f31';
const token='0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c';
const argv=['--match-id',matchId,'--admin-address',admin];
const base={matchId,externalTradeId,adminAddress:admin,tokenAddress:token,buyerAddress:buyer,
 amountMicrousd:'250232',buyerTeusdUnits:'0',buyerHbarWei:'200000000000000000',
 adminHbarWei:'989528855720000000000',adminHasMinterRole:true,
 tokenDecimals:6,tokenSymbol:'TEUSD',chainId:296,matchStatus:'SELECTED',escrowPaused:false,
 existingLocalTrade:null,existingOnChainId:'0'};
const expectedHbar=canonicalIntent({matchId,operation:'FUND_BUYER_HBAR',externalTradeId,
 signerAddress:operator,targetAddress:buyer,valueWei:'200000000000000000',callData:'0x'});
const hbarRow={...expectedHbar, id:'38065271-3ca3-4e18-b3b0-1fce7fb853d6', status:'CONFIRMED',
 txHash:'0x'+'a'.repeat(64),nonce:'3',confirmedAt:new Date('2026-11-09T23:00:00Z')};
const fundingArgs={matchId,externalTradeId,operatorAddress:operator,buyerAddress:buyer};
const receipt={hash:hbarRow.txHash,from:operator,to:buyer,status:1,blockNumber:42};
const tx={hash:hbarRow.txHash,from:operator,to:buyer,value:200000000000000000n,
 data:'0x',chainId:296n,nonce:3};
const reject=(fn,rx)=>assert.throws(fn,rx);

// Parse and permission: no executable signing or send modes can sneak in.
test('default mint action is read-only preview',()=>assert.equal(parseMintArgs(argv).stage,false));
test('stage flag supported',()=>assert.equal(parseMintArgs([...argv,'--stage']).stage,true));
test('reject execute',()=>reject(()=>parseMintArgs([...argv,'--execute']),/Unknown/));
test('reject submit',()=>reject(()=>parseMintArgs([...argv,'--submit']),/Unknown/));
test('reject seal',()=>reject(()=>parseMintArgs([...argv,'--seal']),/Unknown/));
test('reject unexpected amount option',()=>reject(()=>parseMintArgs([...argv,'--amount','999999']),/Unknown/));
test('reject duplicate flag',()=>reject(()=>parseMintArgs([...argv,'--match-id',matchId]),/Unknown/));
test('reject repeated stage',()=>reject(()=>parseMintArgs([...argv,'--stage','--stage']),/Repeated/));
test('reject incomplete flag',()=>reject(()=>parseMintArgs(['--match-id',matchId,'--admin-address']),/Unknown/));
test('reject missing admin',()=>reject(()=>parseMintArgs(['--match-id',matchId]),/Required/));
test('reject invalid match uuid',()=>reject(()=>parseMintArgs(['--match-id','bogus','--admin-address',admin]),/UUID/));
test('reject zero public admin',()=>reject(()=>parseMintArgs(['--match-id',matchId,'--admin-address','0x'+'0'.repeat(40)]),/nonzero/));
test('normalize admin casing',()=>assert.equal(parseMintArgs(argv).adminAddress,admin.toLowerCase()));
test('preview requires no consent',()=>assert.equal(requireMintStagePermission(parseMintArgs(argv),{}),false));
test('stage requires exact consent',()=>reject(()=>requireMintStagePermission(parseMintArgs([...argv,'--stage']),{B14_STAGE_MINT_CONFIRM:'YES'}),/requires/));
test('stage exact consent is accepted',()=>assert.equal(requireMintStagePermission(parseMintArgs([...argv,'--stage']),{B14_STAGE_MINT_CONFIRM:'STAGE_EXACT_TEUSD_MINT_NO_TX'}),true));

// Token amount is B12 derived; calldata always calls mint(buyer, exact microtokens).
test('selector for canonical mint(address,uint256)',()=>assert.equal(MINT_SELECTOR,'0x40c10f19'));
test('canonical mint calldata encodes recipient and exact 250232 units',()=>assert.equal(
 exactMintCalldata(buyer,'250232'),MINT_SELECTOR+'0'.repeat(24)+buyer.slice(2).toLowerCase()+'0'.repeat(59)+'3d178'));
test('cannot mint to zero buyer',()=>reject(()=>exactMintCalldata('0x'+'0'.repeat(40),'250232'),/nonzero/));
test('cannot mint zero units',()=>reject(()=>exactMintCalldata(buyer,'0'),/out of range/));
test('cannot mint beyond safety cap',()=>reject(()=>exactMintCalldata(buyer,'10000001'),/cap/));
test('cannot mint a scientific amount',()=>reject(()=>exactMintCalldata(buyer,'2.50232e5'),/decimal/));
test('cannot mint decimal fractions of token base unit',()=>reject(()=>exactMintCalldata(buyer,'250232.1'),/decimal/));
test('Teusd format retains all six decimals',()=>assert.equal(displayTeusd('250232'),'0.250232'));
test('Teusd format of one micro unit',()=>assert.equal(displayTeusd('1'),'0.000001'));

// Prior signed and confirmed HBAR funding is a mandatory chain-of-custody prerequisite.
test('exact confirmed HBAR journal is accepted',()=>assert.equal(requireConfirmedBuyerHbar(hbarRow,fundingArgs).payloadSha256,expectedHbar.payloadSha256));
test('missing HBAR row refused',()=>reject(()=>requireConfirmedBuyerHbar(null,fundingArgs),/not fully confirmed/));
test('pending HBAR row refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,status:'SUBMITTED'},fundingArgs),/not fully confirmed/));
test('unsigned HBAR row refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,txHash:null},fundingArgs),/not fully confirmed/));
test('missing confirmedAt refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,confirmedAt:null},fundingArgs),/not fully confirmed/));
test('wrong HBAR recipient refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,targetAddress:admin},fundingArgs),/does not match/));
test('wrong HBAR fingerprint refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,payloadSha256:'b'.repeat(64)},fundingArgs),/does not match/));
test('different HBAR operator refused',()=>reject(()=>requireConfirmedBuyerHbar(hbarRow,{...fundingArgs,operatorAddress:admin}),/does not match/));
test('wrong match refused',()=>reject(()=>requireConfirmedBuyerHbar({...hbarRow,matchId:'f6fcce06-ec80-5939-9473-cfea17eeb3b7'},fundingArgs),/not fully confirmed/));
test('confirmed funding chain receipt is accepted',()=>assert.equal(confirmBuyerHbarOnChain(receipt,tx,hbarRow,{buyerAddress:buyer,operatorAddress:operator}),true));
test('missing receipt refused',()=>reject(()=>confirmBuyerHbarOnChain(null,tx,hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('reverted receipt refused',()=>reject(()=>confirmBuyerHbarOnChain({...receipt,status:0},tx,hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('wrong onchain HBAR amount refused',()=>reject(()=>confirmBuyerHbarOnChain(receipt,{...tx,value:1n},hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('wrong onchain buyer refused',()=>reject(()=>confirmBuyerHbarOnChain(receipt,{...tx,to:admin},hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('unexpected chain refused',()=>reject(()=>confirmBuyerHbarOnChain(receipt,{...tx,chainId:295n},hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('unexpected nonce refused',()=>reject(()=>confirmBuyerHbarOnChain(receipt,{...tx,nonce:4},hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));
test('transaction carrying calldata refused',()=>reject(()=>confirmBuyerHbarOnChain(receipt,{...tx,data:'0xab'},hbarRow,{buyerAddress:buyer,operatorAddress:operator}),/Cannot independently/));

// Exact verified B12 mint intent with strict no-overmint guard.
const plan=prepareMintIntent(base);
test('canonical mint operation is MINT_TEUSD',()=>assert.equal(plan.operation,'MINT_TEUSD'));
test('mint payable value is zero',()=>assert.equal(plan.valueWei,'0'));
test('mint signer is minter admin',()=>assert.equal(plan.signerAddress,admin.toLowerCase()));
test('mint contract is canonical token address',()=>assert.equal(plan.targetAddress,token.toLowerCase()));
test('mint call data pins exact buyer',()=>assert.ok(plan.callData.includes(buyer.slice(2).toLowerCase())));
test('mint plan is deterministic',()=>assert.equal(prepareMintIntent(base).payloadSha256,plan.payloadSha256));
test('changing mint amount changes immutable digest',()=>assert.notEqual(prepareMintIntent({...base,amountMicrousd:'250233'}).payloadSha256,plan.payloadSha256));
test('changing buyer changes immutable digest',()=>assert.notEqual(prepareMintIntent({...base,buyerAddress:operator}).payloadSha256,plan.payloadSha256));
test('wrong network blocked',()=>reject(()=>prepareMintIntent({...base,chainId:295}),/chain/));
test('wrong status blocked',()=>reject(()=>prepareMintIntent({...base,matchStatus:'TRADE_CREATED'}),/SELECTED/));
test('paused escrow blocked',()=>reject(()=>prepareMintIntent({...base,escrowPaused:true}),/paused/));
test('local trade exists blocked',()=>reject(()=>prepareMintIntent({...base,existingLocalTrade:{id:'x'}}),/Existing PostgreSQL/));
test('on-chain trade exists blocked',()=>reject(()=>prepareMintIntent({...base,existingOnChainId:'1'}),/Existing on-chain/));
test('admin missing MINTER_ROLE blocked',()=>reject(()=>prepareMintIntent({...base,adminHasMinterRole:false}),/MINTER_ROLE/));
test('wrong token decimals blocked',()=>reject(()=>prepareMintIntent({...base,tokenDecimals:18}),/precision/));
test('wrong token symbol blocked',()=>reject(()=>prepareMintIntent({...base,tokenSymbol:'USDT'}),/precision/));
test('cannot mint to admin itself',()=>reject(()=>prepareMintIntent({...base,buyerAddress:admin}),/distinct/));
test('buyer already has TEUSD is blocked',()=>reject(()=>prepareMintIntent({...base,buyerTeusdUnits:'1'}),/already owns/));
test('buyer insufficient HBAR blocked',()=>reject(()=>prepareMintIntent({...base,buyerHbarWei:'99999999999999999'}),/at least 0.1/));
test('admin insufficient reserve blocked',()=>reject(()=>prepareMintIntent({...base,adminHbarWei:'999999999999999999'}),/at least 1/));
test('mint beyond 10 TEUSD cap blocked',()=>reject(()=>prepareMintIntent({...base,amountMicrousd:'10000001'}),/cap/));
test('zero amount blocked',()=>reject(()=>prepareMintIntent({...base,amountMicrousd:'0'}),/out of range/));
test('no manual mint operation can get through CLI',()=>reject(()=>parseMintArgs([...argv,'--recipient',admin]),/Unknown/));

// Journal idempotency and ordering.
test('only prior funded HBAR journal allowed',()=>assert.equal(disallowPrematureOperations([hbarRow]),true));
test('can have existing B5 PLANNED journal',()=>assert.equal(disallowPrematureOperations([hbarRow,{operation:'MINT_TEUSD'}]),true));
test('cannot stage after CREATE_TRADE intent',()=>reject(()=>disallowPrematureOperations([hbarRow,{operation:'CREATE_TRADE'}]),/Later operations/));
test('cannot stage after APPROVE_ESCROW intent',()=>reject(()=>disallowPrematureOperations([hbarRow,{operation:'APPROVE_ESCROW'}]),/Later operations/));
test('duplicate operation rows refused',()=>reject(()=>disallowPrematureOperations([hbarRow,hbarRow]),/Duplicate/));
test('new mint intent disposition CREATE',()=>assert.equal(existingMintDisposition(null,plan),'CREATE'));
test('unchanged PLANNED intent disposition UNCHANGED',()=>assert.equal(existingMintDisposition({...plan,status:'PLANNED'},plan),'UNCHANGED'));
test('signed mint intent cannot be replanned',()=>reject(()=>existingMintDisposition({...plan,status:'SIGNED'},plan),/reconcile/));
test('changed immutable payload cannot overwrite',()=>reject(()=>existingMintDisposition({...plan,status:'PLANNED',payloadSha256:'b'.repeat(64)},plan),/conflict/));
test('wrong external id cannot overwrite',()=>reject(()=>existingMintDisposition({...plan,status:'PLANNED',externalTradeId:'0x'+'b'.repeat(64)},plan),/external trade/));
