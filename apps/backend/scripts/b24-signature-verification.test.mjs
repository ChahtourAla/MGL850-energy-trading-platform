import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,TypedDataEncoder} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';

test('recorded authorization binds buyer, typed-data digest and deployment domain',async()=>{
 const buyer=Wallet.createRandom(),other=Wallet.createRandom();
 const domain={name:'Offline test',version:'1',chainId:31337,verifyingContract:'0x0000000000000000000000000000000000000001'};
 const types={Payment:[{name:'buyer',type:'address'},{name:'amount',type:'uint256'}]};
 const terms={buyer:buyer.address,amount:2541n};
 const digest=TypedDataEncoder.hash(domain,types,terms);
 const reservation={buyerAddress:buyer.address,settlementId:digest,terms:{domain,types,terms,settlementId:digest}};
 const signature=await buyer.signTypedData(domain,types,terms);
 assert.equal(verifyRecordedAuthorization(reservation,signature),true);
 assert.equal(verifyRecordedAuthorization(reservation,'0x'+'00'.repeat(65)),false);
 assert.equal(verifyRecordedAuthorization(reservation,await other.signTypedData(domain,types,terms)),false);
 assert.equal(verifyRecordedAuthorization({...reservation,buyerAddress:other.address},signature),false);
 assert.equal(verifyRecordedAuthorization({...reservation,settlementId:'0x'+'11'.repeat(32)},signature),false);
 const changed={...reservation,terms:{...reservation.terms,domain:{...domain,chainId:296}}};
 assert.equal(verifyRecordedAuthorization(changed,signature),false);
 assert.equal(verifyRecordedAuthorization(reservation,'0x12'),false);
});
