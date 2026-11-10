import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {selectB16Python,b16PythonEnv,b16PythonFailure} from './b16-python-runner.mjs';

const root=join('tmp','repo');
test('explicit B16_PYTHON overrides any venv, including paths with spaces',()=>{
  assert.equal(selectB16Python(root,{B16_PYTHON:'"C:\\Program Files\\Python\\python.exe"'},'win32',()=>true),'C:\\Program Files\\Python\\python.exe');
});
test('Windows root venv is preferred',()=>{
 const path=join(root,'.venv','Scripts','python.exe');
 assert.equal(selectB16Python(root,{},'win32',p=>p===path),path);
});
test('Windows data-generator venv is fallback',()=>{
 const path=join(root,'services','data-generator','.venv','Scripts','python.exe');
 assert.equal(selectB16Python(root,{},'win32',p=>p===path),path);
});
test('POSIX venv and system Python fallback',()=>{
 const path=join(root,'.venv','bin','python');
 assert.equal(selectB16Python(root,{},'linux',p=>p===path),path);
 assert.equal(selectB16Python(root,{},'linux',()=>false),'python');
});
test('rejects newline injection in interpreter name',()=>{
 assert.throws(()=>selectB16Python(root,{B16_PYTHON:'python\nmore'}),/Invalid/);
});
test('PYTHONPATH includes local service and shared Python modules',()=>{
 const env=b16PythonEnv(root,{PATH:'abc'},';');
 assert.equal(env.PYTHONPATH,[join(root,'packages','shared','python'),join(root,'services','data-generator')].join(';'));
 assert.equal(env.PATH,'abc');
});
test('preserves inherited PYTHONPATH and normalizes casing',()=>{
 const env=b16PythonEnv(root,{PythonPath:'C:\\my-old-deps',PATH:'abc'},';');
 assert.ok(env.PYTHONPATH.endsWith(';C:\\my-old-deps'));
 assert.equal(env.PythonPath,undefined);
});
test('Python stderr is visible and credentials redacted',()=>{
 const message=b16PythonFailure({status:1,stderr:'ModuleNotFoundError: No module named p2p_energy_shared'},'python');
 assert.match(message,/ModuleNotFoundError/);
 const secret=b16PythonFailure({status:1,stderr:'DATABASE_URL=postgresql://user:secret@host:5432/db'},'python');
 assert.doesNotMatch(secret,/user:secret/);
});
test('Python error surfaces spawn failure',()=>{
 assert.match(b16PythonFailure({status:null,error:new Error('spawn python ENOENT')},'python'),/ENOENT/);
});
test('simulator passes explicit local PYTHONPATH and does not broadcast',()=>{
 const src=readFileSync(fileURLToPath(new URL('./b16-oracle.mjs',import.meta.url)),'utf8');
 assert.match(src,/env:b16PythonEnv\(ROOT\)/);
 assert.match(src,/selectB16Python\(ROOT\)/);
 assert.match(src,/B16_SETTLEMENT_CONFIRM/);
 assert.match(src,/B16 SIMULATOR DRY RUN PASS/);
});
