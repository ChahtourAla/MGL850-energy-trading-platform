import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localFixtureIntentId,createLocalSettlementIntent} from './b25-settlement-intent.mjs';
import {executeLocalSettlement} from './b25-settlement-executor.mjs';
import {recoverLocalSettlement} from './b25-settlement-recovery.mjs';
const allocation='0x'+'ab'.repeat(32),token='0x'+'cd'.repeat(20);
test('fixture intent identity is deterministic and token-bound',()=>{
 assert.equal(localFixtureIntentId(allocation,token),localFixtureIntentId(allocation,token));
 assert.notEqual(localFixtureIntentId(allocation,token),localFixtureIntentId(allocation,'0x'+'ef'.repeat(20)));
 assert.throws(()=>localFixtureIntentId(allocation,'0x'+'CD'.repeat(20)),/Invalid fixture identity/);
});
test('intent, executor and recovery reject arbitrary database targets before querying',async()=>{
 const client={connectionParameters:{host:'remote',database:'production',user:'owner'},query(){throw Error('unexpected query');}};
 await assert.rejects(createLocalSettlementIntent({client}),/Refusing non-disposable/);
 await assert.rejects(executeLocalSettlement({client}),/Refusing non-disposable/);
 await assert.rejects(recoverLocalSettlement({client}),/Refusing non-disposable/);
});
