import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateV2} from '../scripts/b21-v2-validator.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const cases=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/v2-validation-vectors.json',import.meta.url),'utf8'));
test('Python and Node V2 validation decisions agree with shared positive and negative vectors',()=>{
 const node=cases.map(c=>{try{validateV2(c.kind,c.value,c.context);return {name:c.name,accepted:true};}catch{return {name:c.name,accepted:false};}});
 const result=spawnSync(process.env.B21_PYTHON || 'python',['packages/shared/tests/b21-parity.py'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const python=JSON.parse(result.stdout);assert.deepEqual(node,python);assert.deepEqual(node.map(x=>x.accepted),cases.map(x=>x.valid));
});
