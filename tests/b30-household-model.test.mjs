import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdOverview } from '../apps/frontend/src/components/b30-household-model.ts';
const users=[{userId:'u1',name:'Household 0001'},{userId:'u2',name:'Household 0011'},{userId:'u3',name:'Household 0009'}];
const t={allocationId:'0x'+'a'.repeat(64),intervalStart:'2026-11-10T14:00:00Z',marketId:'0x'+'b'.repeat(64),side:'SOLD',counterparty:{name:'Household 0011'},quantityWh:'246',expectedPaymentBaseUnits:'20956',network:'HEDERA_TESTNET',paymentStatus:'NOT_SUBMITTED'};
test('lists unmatched household with no fake payment',()=>{const r=buildHouseholdOverview(users,[{userId:'u1',trades:[t],hasMore:false,failed:false},{userId:'u2',trades:[{...t,side:'BOUGHT',counterparty:{name:'Household 0001'}}],hasMore:false,failed:false},{userId:'u3',trades:[],hasMore:false,failed:false}]);assert.equal(r.trades.length,1);assert.equal(r.householdStates[2].status,'NO_MATCH');assert.equal(r.trades[0].buyerName,'Household 0011');assert.equal(r.trades[0].sellerName,'Household 0001');});
test('failed household fetch is not called no match',()=>{const r=buildHouseholdOverview(users,[{userId:'u1',trades:[],hasMore:false,failed:true}]);assert.equal(r.complete,false);assert.equal(r.householdStates[0].status,'UNAVAILABLE');});
test('pagination never falsely claims complete',()=>{const r=buildHouseholdOverview(users,[{userId:'u1',trades:[t],hasMore:true,failed:false}]);assert.equal(r.complete,false);assert.equal(r.householdStates[0].status,'PARTIAL');});
