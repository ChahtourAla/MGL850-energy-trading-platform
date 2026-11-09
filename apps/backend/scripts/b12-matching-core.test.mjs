import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseB12Args, importedSnapshotDigest, makeMatchingInput, stableMatchingResult,
  hashValue, assertMatchingBusinessRules, compareStoredMatches, verifyBatchFingerprint,
  requireB12Confirmation,
} from './b12-matching-core.mjs';

const readFixture = (file) => JSON.parse(readFileSync(new URL(`../../../packages/shared/fixtures/${file}`, import.meta.url), 'utf8'));
const snapshot = readFixture('energy-snapshot.sample.json');
const config = readFixture('matching-config.sample.json');
const output = readFixture('matching-output.sample.json');
const input = makeMatchingInput(snapshot, config, 2);
const row = {
  id: output.matches[0].matchId, timeSlot: new Date(output.matches[0].timeSlot),
  buyerId: output.matches[0].buyerId, sellerId: output.matches[0].sellerId,
  quantityWh: BigInt(output.matches[0].quantityWh),
  unitPriceMicrousdPerKwh: BigInt(output.matches[0].unitPriceMicrousdPerKwh),
  totalAmountMicrousd: BigInt(output.matches[0].totalAmountMicrousd),
  distanceKm: String(output.matches[0].distanceKm), score: String(output.matches[0].score),
  sellerEnergyType: output.matches[0].sellerEnergyType,
  algorithmVersion: output.matches[0].algorithmVersion, status: 'SELECTED',
};

// CLI safety
 test('requires explicit snapshot', () => assert.throws(() => parseB12Args([]), /snapshot/));
 test('dry run is default', () => assert.equal(parseB12Args(['--snapshot','foo.json']).execute, false));
 test('rejects unknown or repeated flags', () => {
   assert.throws(() => parseB12Args(['--snapshot','foo','--typo','x']), /Unknown/);
   assert.throws(() => parseB12Args(['--snapshot','foo','--snapshot','bar']), /repeated/);
 });
 test('bounded timeouts and expected households', () => {
   assert.throws(() => parseB12Args(['--snapshot','foo','--timeout-ms','0']), /timeout-ms/);
   assert.throws(() => parseB12Args(['--snapshot','foo','--expected-users','201']), /expected-users/);
 });
 test('live writes need a separate confirmation gate', () => {
   const opts = parseB12Args(['--snapshot','foo','--execute']);
   assert.throws(() => requireB12Confirmation(opts, {}), /disabled/);
   assert.doesNotThrow(() => requireB12Confirmation(opts, {B12_MATCH_IMPORT_CONFIRM:'YES'}));
   assert.doesNotThrow(() => requireB12Confirmation({execute:false}, {}));
 });

// Canonical source and output
 test('builds exact canonical matching input and sorts participants', () => {
   assert.deepEqual(input.users.map(u=>u.userId), snapshot.users.map(u=>u.userId).sort());
   assert.equal(input.algorithmVersion, config.algorithmVersion);
 });
 test('rejects partial set', () => assert.throws(() => makeMatchingInput(snapshot, config, 12), /exactly 12/));
 test('rejects modified algorithm schema', () => assert.throws(() => makeMatchingInput(snapshot, {...config,schemaVersion:'9.0.0'},2), /config version/));
 test('source digest ignores user ordering', () => {
   const reversed = {...snapshot,users:[...snapshot.users].reverse()};
   assert.equal(importedSnapshotDigest(snapshot),importedSnapshotDigest(reversed));
 });
 test('rejects tampered B09 source hash', () => {
   const batch = { id:snapshot.snapshotId,timeSlot:new Date(snapshot.timeSlot),recordCount:2,
     schemaVersion:snapshot.schemaVersion,generatorVersion:snapshot.generatorVersion,payloadSha256:importedSnapshotDigest(snapshot)};
   assert.doesNotThrow(() => verifyBatchFingerprint(snapshot,batch));
   assert.throws(() => verifyBatchFingerprint(snapshot,{...batch,payloadSha256:'a'.repeat(64)}),/fingerprint/);
 });
 test('hash is independent of metadata timestamp and benchmark duration', () => {
   const changed = structuredClone(output);
   changed.matches[0].createdAt='2026-11-09T12:02:00Z';changed.executionTimeMs=900;
   assert.equal(hashValue(stableMatchingResult(output)),hashValue(stableMatchingResult(changed)));
 });
 test('hash changes when a business field changes', () => {
   const changed=structuredClone(output);changed.matches[0].quantityWh += 1;
   assert.notEqual(hashValue(stableMatchingResult(output)),hashValue(stableMatchingResult(changed)));
 });
 test('accepts correctly matched fixture', () => assert.deepEqual(assertMatchingBusinessRules(input,output),{buyers:1,sellers:1,matched:1,unmatched:0}));
 test('rejects wrong energy preference', () => {
   const altered=structuredClone(input);altered.users.find(u=>u.marketRole==='BUYER').preferredEnergyType='WIND';
   assert.throws(()=>assertMatchingBusinessRules(altered,output),/energy-type/);
 });
 test('rejects forged buyer wallet', () => {
   const altered=structuredClone(output);altered.matches[0].buyerWallet='0x9999999999999999999999999999999999999999';
   assert.throws(()=>assertMatchingBusinessRules(input,altered),/wallets/);
 });
 test('rejects seller inventory overspend', () => {
   const altered=structuredClone(output);altered.matches[0].quantityWh=5000;
   assert.throws(()=>assertMatchingBusinessRules(input,altered),/quantities/);
 });
 test('rejects missing unmatched IDs', () => {
   const altered=structuredClone(output);altered.matches=[];
   assert.throws(()=>assertMatchingBusinessRules(input,altered),/unmatched/);
 });
 test('accepts no-match case when buyer is genuinely unmatched', () => {
   const altered=structuredClone(output);altered.matches=[];altered.unmatchedBuyerIds=[output.matches[0].buyerId];
   assert.deepEqual(assertMatchingBusinessRules(input,altered).unmatched,1);
 });

// Immutable PostgreSQL idempotency
 test('exact same committed match is unchanged', () => assert.doesNotThrow(()=>compareStoredMatches([row],[row])));
 test('different status is a conflict, never overwritten', () => {
   assert.throws(()=>compareStoredMatches([{...row,status:'TRADE_CREATED'}],[row]),/status/);
 });
 test('different quantity is a conflict', () => assert.throws(()=>compareStoredMatches([{...row,quantityWh:5n}],[row]),/quantityWh/));
 test('missing row cannot pass', () => assert.throws(()=>compareStoredMatches([],[row]),/count/));
 test('duplicate IDs cannot pass', () => assert.throws(()=>compareStoredMatches([row,row],[row,row]),/duplicate/));
