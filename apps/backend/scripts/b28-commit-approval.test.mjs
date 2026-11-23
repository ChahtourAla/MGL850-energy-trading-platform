import {test} from 'node:test';
import assert from 'node:assert/strict';
import {b28ProposalDigest,parseB28Args,validateB28Approval} from './b28-commit-approval.mjs';

const h=n=>'0x'+n.repeat(64);
function fixture(){return {marketId:h('a'),snapshotId:'7372cfa7-d41f-5246-969a-5ccfb6033a7f',snapshotHash:h('b'),planId:h('c'),manifestHash:h('d'),policy:'b28-teusd-half-even-1',allocations:[{id:h('e'),buyerId:'buyer1',sellerId:'seller1',buyerAddress:'0x'+'1'.repeat(40),sellerAddress:'0x'+'2'.repeat(40),quantityWh:'246',unitPriceMicrousdPerKwh:'85187',amountBaseUnits:'20956',remainder:2,pricingVersion:'b28-teusd-half-even-1',planVersion:'b28-sample'}],positions:[{userId:'buyer1',role:'BUYER',productionWh:'0',consumptionWh:'246',matchedBoughtWh:'246',matchedSoldWh:'0'},{userId:'seller1',role:'SELLER',productionWh:'300',consumptionWh:'0',matchedBoughtWh:'0',matchedSoldWh:'246'}]};}
const options=p=>({confirmation:p.marketId,planConfirmation:p.planId,proposalConfirmation:b28ProposalDigest(p)});

test('preview parsing remains read-only with only snapshot',()=>{const o=parseB28Args(['--snapshot=original.json']);assert.equal(o.commit,false);assert.equal(o.confirmation,undefined);});
test('rejects commit without all three confirmation hashes',()=>{const p=fixture();assert.throws(()=>parseB28Args(['--snapshot=original.json','--commit',`--confirm-market=${p.marketId}`,`--confirm-plan=${p.planId}`]),/all three|AND --confirm-proposal/);});
test('rejects partial confirmation options during preview',()=>{const p=fixture();assert.throws(()=>parseB28Args(['--snapshot=original.json',`--confirm-plan=${p.planId}`]),/only valid with --commit/);});
test('rejects malformed and duplicate options',()=>{assert.throws(()=>parseB28Args(['--snapshot=original.json','--evil']),/unknown/);assert.throws(()=>parseB28Args(['--snapshot=one','--snapshot=two']),/duplicate/);});
test('accepts complete commit syntax with strict hash confirmation',()=>{const p=fixture();const o=parseB28Args(['--snapshot=original.json','--commit',`--confirm-market=${p.marketId}`,`--confirm-plan=${p.planId}`,`--confirm-proposal=${b28ProposalDigest(p)}`]);assert.equal(o.commit,true);assert.equal(o.proposalConfirmation,b28ProposalDigest(p));});
test('proposal digest is deterministic and order-independent for positions',()=>{const p=fixture();const q=fixture();q.positions.reverse();assert.equal(b28ProposalDigest(p),b28ProposalDigest(q));});
test('approval permits the exact matched plan',()=>{const p=fixture();assert.doesNotThrow(()=>validateB28Approval(options(p),p,'I_APPROVE_SIMULATED_V2_MARKET'));});
test('approval requires explicit environment opt-in',()=>{const p=fixture();assert.throws(()=>validateB28Approval(options(p),p,undefined),/disabled/);});
test('approval detects different market and plan identifiers',()=>{const p=fixture();const o=options(p);assert.throws(()=>validateB28Approval({...o,confirmation:h('f')},p,'I_APPROVE_SIMULATED_V2_MARKET'),/market ID/);assert.throws(()=>validateB28Approval({...o,planConfirmation:h('f')},p,'I_APPROVE_SIMULATED_V2_MARKET'),/plan ID/);});
test('approval prevents changed payment base units without changing plan ID',()=>{const p=fixture();const o=options(p);p.allocations[0].amountBaseUnits='20957';assert.throws(()=>validateB28Approval(o,p,'I_APPROVE_SIMULATED_V2_MARKET'),/proposal digest/);});
test('approval prevents changed buyer, seller or energy quantities',()=>{const p=fixture();const o=options(p);p.allocations[0].buyerId='buyer2';assert.throws(()=>validateB28Approval(o,p,'I_APPROVE_SIMULATED_V2_MARKET'),/proposal digest/);});
test('approval prevents changed market positions',()=>{const p=fixture();const o=options(p);p.positions[0].matchedBoughtWh='245';assert.throws(()=>validateB28Approval(o,p,'I_APPROVE_SIMULATED_V2_MARKET'),/proposal digest/);});
