import test from 'node:test';
import assert from 'node:assert/strict';
import {withLocalTimeout} from './b24-local-timeout.mjs';

test('local timeout preserves successful and failed results',async()=>{
 assert.equal(await withLocalTimeout(Promise.resolve('ok'),50),'ok');
 await assert.rejects(withLocalTimeout(Promise.reject(Error('failure')),50),/failure/);
});
test('a pending local operation times out without assuming it did not submit',async()=>{
 await assert.rejects(withLocalTimeout(new Promise(()=>{}),5),/outcome uncertain/);
 await assert.rejects(withLocalTimeout(Promise.resolve(),0),/Invalid local timeout/);
});
