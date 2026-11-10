import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { patchB17Schema } from './install-b17-schema.mjs';
const fixture=`generator client {\n  provider = "prisma-client"\n}\nmodel Match {\n  id String @id\n  b14TransactionIntents B14TransactionIntent[]\n  b16OracleIntent B16OracleIntent?\n}\nmodel Trade {\n  id String @id\n}\n`;
test('adds only B17 relation and model without altering B14/B16',()=>{
 const result=patchB17Schema(fixture);
 assert.match(result,/b17OperatorIntents B17OperatorIntent\[\]/);
 assert.match(result,/model B17OperatorIntent \{/);
 assert.match(result,/@@unique\(\[matchId, operation\]\)/);
 assert.match(result,/b14TransactionIntents B14TransactionIntent\[\]/);
 assert.match(result,/b16OracleIntent B16OracleIntent\?/);
 assert.match(result,/model Trade \{\n  id String @id\n\}/);
 assert.equal(result.match(/model Match/g).length,1);
});
test('installer idempotent',()=>{
 const once=patchB17Schema(fixture);
 assert.equal(patchB17Schema(once),once);
});
test('missing Match blocked',()=>assert.throws(()=>patchB17Schema('model Trade {\n id String @id\n}')));
test('duplicated Match blocked',()=>assert.throws(()=>patchB17Schema(fixture+fixture)));
test('broken prior B17 relation blocked',()=>assert.throws(()=>patchB17Schema(fixture+'model B17OperatorIntent {\n id String @id\n}')));
test('partial duplicate relation blocked',()=>assert.throws(()=>patchB17Schema(fixture.replace('b16OracleIntent','b17OperatorIntents'))));
test('migration has no statements affecting B14/B16 tables',()=>{
 const content=readFileSync(fileURLToPath(new URL('../database/migrations/20261110061000_b17_operator_intents/migration.sql',import.meta.url)),'utf8');
 assert.match(content,/CREATE TABLE "b17_operator_intents"/);
 assert.match(content,/FOREIGN KEY \("match_id"\) REFERENCES "matches"/);
 assert.doesNotMatch(content,/ALTER TABLE "b14_transaction_intents"|ALTER TABLE "b16_oracle_intents"|DROP TABLE|TRUNCATE|DELETE FROM/);
});
