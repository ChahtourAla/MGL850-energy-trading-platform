import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireUuid, requireUint, requireAddress, parseB14Args, externalTradeId, computePayment,
  chooseMatch, assertStoredMatch, tradeWindow, assertExistingChainMatches,
} from './b14-trade-core.mjs';

const b='11111111-1111-4111-8111-111111111111';
const s='22222222-2222-4222-8222-222222222222';
const m='33333333-3333-4333-8333-333333333333';
const snapshot='44444444-4444-4444-8444-444444444444';
const buyer='0x1111111111111111111111111111111111111111';
const seller='0x2222222222222222222222222222222222222222';
const escrow='0xf60d732EA588499D6984179B6F60f80b2FD67e5D';
const hour=new Date('2026-11-09T12:00:00.000Z');
function fixture() {
  const match={id:m,timeSlot:hour,buyerId:b,sellerId:s,quantityWh:5000n,unitPriceMicrousdPerKwh:140000n,totalAmountMicrousd:700000n,status:'SELECTED'};
  const run={snapshotId:snapshot,timeSlot:hour,matchCount:1};
  const rows=[match];
  const energyRecords=[
    {userId:b,timeSlot:hour,snapshotId:snapshot,marketRole:'BUYER',requiredEnergyWh:5000n,maxPriceMicrousdPerKwh:150000n},
    {userId:s,timeSlot:hour,snapshotId:snapshot,marketRole:'SELLER',availableEnergyWh:8000n,askPriceMicrousdPerKwh:140000n,energyType:'SOLAR'},
  ];
  const buyerWallet={userId:b,evmAddress:buyer};
  const sellerWallet={userId:s,evmAddress:seller};
  const buyerProfile={id:b,preferredEnergyType:'SOLAR'};
  return {match,run,rows,energyRecords,buyerWallet,sellerWallet,buyerProfile};
}

test('offline switch is harmless and standalone',()=>assert.deepEqual(parseB14Args(['--offline']),{offline:true}));
test('cannot combine offline with live',()=>assert.throws(()=>parseB14Args(['--offline','--time-slot','2026-11-09T12:00:00Z'])));
test('live requires explicit time and delivery',()=>assert.throws(()=>parseB14Args([])));
test('rejects unrecognized live execute switch',()=>assert.throws(()=>parseB14Args(['--execute'])));
test('rejects unknown argument',()=>assert.throws(()=>parseB14Args(['--xyz','anything'])));
test('rejects repeated argument',()=>assert.throws(()=>parseB14Args(['--time-slot','2026-11-09T12:00:00Z','--time-slot','2026-11-09T13:00:00Z'])));
test('rejects non-hour snapshot timestamp',()=>assert.throws(()=>parseB14Args(['--time-slot','2026-11-09T12:30:00Z','--delivery-start','2026-11-10T12:00:00Z'])));
test('rejects timezone offset in delivery',()=>assert.throws(()=>parseB14Args(['--time-slot','2026-11-09T12:00:00Z','--delivery-start','2026-11-10T12:00:00+00:00'])));
test('accepts full live options',()=>assert.equal(parseB14Args(['--time-slot','2026-11-09T12:00:00Z','--match-id',m,'--delivery-start','2026-11-10T12:00:00Z','--operator-address',buyer]).matchId,m));
test('rejects malformed operator wallet',()=>assert.throws(()=>parseB14Args(['--time-slot','2026-11-09T12:00:00Z','--delivery-start','2026-11-10T12:00:00Z','--operator-address','0x123'])));
test('rejects unsupported UUID shape',()=>assert.throws(()=>requireUuid('invalid')));
test('rejects zero and malformed addresses',()=>{assert.throws(()=>requireAddress('0x'+'0'.repeat(40)));assert.throws(()=>requireAddress('0x123'));});
test('rejects unsigned numeric scientific strings',()=>assert.throws(()=>requireUint('1e4','price')));
test('rejects zero amount in positive context',()=>assert.throws(()=>requireUint('0','qty',{positive:true})));
test('rejects over-sized uint256',()=>assert.throws(()=>requireUint(1n<<256n,'qty')));
test('Solidity price calculation is integer-exact',()=>assert.equal(computePayment('5000','140000'),700000n));
test('rounding to zero payment is rejected',()=>assert.throws(()=>computePayment('1','1')));
test('overflow multiplication is rejected',()=>assert.throws(()=>computePayment(1n<<255n,'2')));
test('deterministic external ID is bytes32',()=>{const id=externalTradeId(m,escrow);assert.match(id,/^0x[0-9a-f]{64}$/);assert.equal(id,externalTradeId(m,escrow.toUpperCase().replace('0X','0x')));});
test('different match means different intent',()=>assert.notEqual(externalTradeId(m,escrow),externalTradeId(b,escrow)));
test('selects sole committed match',()=>assert.equal(chooseMatch(fixture().rows).id,m));
test('multiple match rows require explicit selection',()=>assert.throws(()=>chooseMatch([fixture().match,{...fixture().match,id:b}])));
test('non-SELECTED match refuses transaction planning',()=>assert.throws(()=>chooseMatch([{...fixture().match,status:'TRADE_CREATED'}])));
test('trusted B12 match validates',()=>assert.equal(assertStoredMatch(fixture()).totalAmountMicrousd,'700000'));
test('rejects mutated quantity vs buyer request',()=>{const f=fixture();f.match.quantityWh=4000n;assert.throws(()=>assertStoredMatch(f));});
test('rejects total tampering',()=>{const f=fixture();f.match.totalAmountMicrousd=699999n;assert.throws(()=>assertStoredMatch(f));});
test('rejects changed seller asking price',()=>{const f=fixture();f.energyRecords[1].askPriceMicrousdPerKwh=160000n;assert.throws(()=>assertStoredMatch(f));});
test('rejects changed buyer maximum price',()=>{const f=fixture();f.energyRecords[0].maxPriceMicrousdPerKwh=100000n;assert.throws(()=>assertStoredMatch(f));});
test('rejects wrong wallet user mapping',()=>{const f=fixture();f.buyerWallet.userId=s;assert.throws(()=>assertStoredMatch(f));});
test('rejects energy preferences mismatch',()=>{const f=fixture();f.buyerProfile.preferredEnergyType='WIND';assert.throws(()=>assertStoredMatch(f));});
test('rejects run row count mismatch',()=>{const f=fixture();f.run.matchCount=2;assert.throws(()=>assertStoredMatch(f));});
test('rejects double allocation to same buyer',()=>{const f=fixture();f.rows.push({...f.match,id:b});f.run.matchCount=2;assert.throws(()=>assertStoredMatch(f));});
test('rejects oversold seller',()=>{const f=fixture();f.energyRecords[1].availableEnergyWh=4999n;assert.throws(()=>assertStoredMatch(f));});
test('rejects existing trade mismatch',()=>{const f=fixture(), plan=assertStoredMatch(f);assert.throws(()=>assertExistingChainMatches({...plan,externalTradeId:externalTradeId(m,escrow),buyer:seller},plan,externalTradeId(m,escrow)));});
test('accepts verified on-chain identical trade',()=>{const f=fixture(),plan=assertStoredMatch(f);assert.doesNotThrow(()=>assertExistingChainMatches({...plan,externalTradeId:externalTradeId(m,escrow)},plan,externalTradeId(m,escrow)));});
test('delivery window is exactly one hour',()=>{const a=tradeWindow('2026-11-10T12:00:00Z',new Date('2026-11-09T12:00:00Z'));assert.equal(BigInt(a.deliveryDeadline)-BigInt(a.deliveryStart),3600n);});
test('rejects already expired/past delivery window',()=>assert.throws(()=>tradeWindow('2026-11-09T12:00:00Z',new Date('2026-11-09T12:01:00Z'))));
test('rejects implausibly distant delivery window',()=>assert.throws(()=>tradeWindow('2026-12-15T12:00:00Z',new Date('2026-11-09T12:00:00Z'))));
