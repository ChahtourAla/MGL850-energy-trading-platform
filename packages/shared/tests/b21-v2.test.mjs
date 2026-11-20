import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {marketId,snapshotHash,allocationId,paymentParts,uint} from '../v2-identity.mjs';
const v=JSON.parse(readFileSync(new URL('../fixtures/v2-identity-vectors.json',import.meta.url),'utf8'));
test('cross-language market snapshot allocation vectors',()=>{assert.equal(marketId(...v.market.args),v.market.id);assert.equal(snapshotHash(v.snapshot.marketId,v.snapshot.participants),v.snapshot.hash);assert.equal(allocationId(...v.allocation.args),v.allocation.id);});
test('identities are stable and term sensitive',()=>{assert.equal(snapshotHash(v.snapshot.marketId,[...v.snapshot.participants].reverse()),v.snapshot.hash);assert.notEqual(marketId('simulation:demo','SIMULATION',...v.market.args.slice(2)),v.market.id);const a=[...v.allocation.args];a[7]='12346';assert.notEqual(allocationId(...a),v.allocation.id);});
test('exact arithmetic and bad values',()=>{assert.deepEqual(paymentParts('900','12345'),{amountBaseUnits:'11110',remainder:500});assert.deepEqual(paymentParts('0','4'),{amountBaseUnits:'0',remainder:0});for(const x of ['-1','01','9223372036854775808',1])assert.throws(()=>uint(x));assert.throws(()=>paymentParts('9223372036854775807','9223372036854775807'));assert.throws(()=>snapshotHash(v.snapshot.marketId,[...v.snapshot.participants,...v.snapshot.participants]));});
test('logical intent vector',async()=>{const {intentId}=await import('../v2-identity.mjs');assert.equal(intentId(...v.intent.args),v.intent.id);});
