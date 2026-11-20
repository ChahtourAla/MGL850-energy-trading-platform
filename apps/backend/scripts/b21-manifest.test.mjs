import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingInputHash } from '../../../packages/shared/v2-identity.mjs';
import { validateV2 } from './b21-v2-validator.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/v2-matching-manifest-vectors.json',import.meta.url),'utf8'));
test('economic manifest base, participant order and Python parity',()=>{
 assert.equal(matchingInputHash(fixture.manifest),fixture.hash);
 assert.equal(matchingInputHash({...fixture.manifest,participants:[...fixture.manifest.participants].reverse()}),fixture.hash);
 validateV2('matchingManifest',fixture.manifest);
 const py=spawnSync(process.env.B21_PYTHON||'python',['packages/shared/tests/b21-manifest-parity.py'],{encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);assert.deepEqual(JSON.parse(py.stdout),[fixture.hash,...fixture.variants.map(v=>v.hash)]);
});
for(const entry of fixture.variants)test(`economic term changes hash: ${entry.name}`,()=>{validateV2('matchingManifest',entry.manifest);assert.equal(matchingInputHash(entry.manifest),entry.hash);assert.notEqual(entry.hash,fixture.hash);});
