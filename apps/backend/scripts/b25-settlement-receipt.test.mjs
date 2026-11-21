import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSettlementReceipt} from './b25-settlement-receipt.mjs';

test('rejects an unregistered chain session before consulting receipt data', async()=>{
 let requests=0;
 const provider={getTransaction(){requests++;},getTransactionReceipt(){requests++;}};
 await assert.rejects(inspectSettlementReceipt({provider,session:{},reservationId:'test',context:{terms:{buyer:'0x0000000000000000000000000000000000000001',token:'0x0000000000000000000000000000000000000002'},contract:'0x0000000000000000000000000000000000000003'}}),/Unknown or mismatched local chain session/);
 assert.equal(requests,0);
});
