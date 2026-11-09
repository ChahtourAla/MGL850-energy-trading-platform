import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  requireHour, parseArgs, validateRegistry, consumptionOnlyUserIds,
  checkSnapshot, checkImportResult, checkStoredSnapshot,
} from './b11-pipeline-core.mjs';

const A = '11111111-1111-5111-8111-111111111111';
const B = '22222222-2222-5222-8222-222222222222';
const SLOT = '2026-11-09T12:00:00Z';
const SID = '33333333-3333-5333-8333-333333333333';
const RID_A = '44444444-4444-5444-8444-444444444444';
const RID_B = '55555555-5555-5555-8555-555555555555';
const registry = {
  schemaVersion: '1.0.0',
  users: [
    { userId: B, email: 'b@example.invalid', evmAddress: '0x'+'b'.repeat(40), hederaAccountId:'0.0.2000' },
    { userId: A, email: 'a@example.invalid', evmAddress: '0x'+'a'.repeat(40), hederaAccountId:'0.0.1000' },
  ],
};
const snapshot = {
  schemaVersion: '1.0.0', snapshotId: SID, timeSlot: SLOT, generatorVersion: '1.0.0',
  users: [
    { recordId: RID_A, userId: A, timeSlot: SLOT, evmAddress: '0x'+'a'.repeat(40),
      productionWh: 3000, consumptionWh: 1000, netEnergyWh: 2000, availableEnergyWh: 2000, requiredEnergyWh: 0,
      marketRole: 'SELLER', energyType: 'SOLAR', askPriceMicrousdPerKwh: 140000, maxPriceMicrousdPerKwh: null },
    { recordId: RID_B, userId: B, timeSlot: SLOT, evmAddress: '0x'+'b'.repeat(40),
      productionWh: 0, consumptionWh: 2500, netEnergyWh: -2500, availableEnergyWh: 0, requiredEnergyWh: 2500,
      marketRole: 'BUYER', energyType: null, askPriceMicrousdPerKwh: null, maxPriceMicrousdPerKwh: 170000 },
  ],
};
const source = { ...registry, users: registry.users.map(({evmAddress: _e, hederaAccountId: _h, ...user})=>user) };

function stored() {
  return snapshot.users.map(({ recordId, userId, timeSlot, evmAddress: _e, ...rest }) => ({
    id: recordId, userId, timeSlot: new Date(timeSlot), snapshotId: SID,
    ...rest,
    ...Object.fromEntries([
      'productionWh','consumptionWh','netEnergyWh','availableEnergyWh','requiredEnergyWh','askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh',
    ].map(field => [field, rest[field] === null ? null : BigInt(rest[field])])),
  }));
}
const batch = { id: SID, timeSlot: new Date(SLOT), recordCount: 2, schemaVersion: '1.0.0', generatorVersion: '1.0.0' };
const wallets = registry.users.map(u => ({ id: u.userId, wallet: { evmAddress: u.evmAddress } }));

// CLI safety, shape, deterministic selection, response correctness.
test('accepts a real UTC hour', () => assert.equal(requireHour(SLOT), SLOT));
test('rejects a non-hour UTC timestamp', () => assert.throws(() => requireHour('2026-11-09T12:30:00Z')));
test('rejects invalid calendar dates', () => assert.throws(() => requireHour('2026-02-30T12:00:00Z')));
test('rejects offsets instead of UTC Z', () => assert.throws(() => requireHour('2026-11-09T07:00:00-05:00')));
test('CLI requires original registry', () => assert.throws(() => parseArgs(['--time-slot', SLOT])));
test('CLI rejects unrecognized arguments', () => assert.throws(() => parseArgs(['--registry','x','--time-slot', SLOT,'--delete-database'])));
test('CLI defaults to preview with bounded users', () => {
  const args=parseArgs(['--registry','reg.json','--time-slot',SLOT]);
  assert.equal(args.execute,false); assert.equal(args.maxUsers,12); assert.equal(args.expectedUsers,12); assert.equal(args.consumptionOnlyCount,4);
  assert.match(args.config.replaceAll('\\','/'), /services\/data-generator\/config\/energy-generation-config\.json$/);
});
test('CLI rejects excessive users', () => assert.throws(() => parseArgs(['--registry','reg.json','--time-slot',SLOT,'--max-users','201'])));
test('CLI rejects remote plain HTTP', () => assert.throws(() => parseArgs(['--registry','reg.json','--time-slot',SLOT,'--backend-url','http://example.org:3001'])));
test('un-enriched B08 registry is accepted', () => assert.equal(validateRegistry(source,12),2));
test('wallet-ready registry must provide verified-shaped wallet IDs', () => assert.equal(validateRegistry(registry,12,{requireWallets:true}),2));
test('pre-enriched source is rejected before exporter', () => assert.throws(() => validateRegistry(registry,12)));
test('duplicate source identities are rejected', () => assert.throws(() => validateRegistry({...source,users:[source.users[0],source.users[0]]},12)));
test('selection is deterministic independent of input order', () => {
  assert.deepEqual(consumptionOnlyUserIds(registry,1),[A]);
  assert.deepEqual(consumptionOnlyUserIds({...registry,users:[...registry.users].reverse()},1),[A]);
});
test('cannot mark every household consumption-only', () => assert.throws(() => consumptionOnlyUserIds(registry,2)));
test('snapshot identities and roles match the wallet-ready registry', () => assert.deepEqual(checkSnapshot(snapshot,registry,SLOT),{total:2,sellers:1,buyers:1,neutral:0}));
test('snapshot with forged wallet fails', () => {
  const forged=structuredClone(snapshot); forged.users[0].evmAddress = '0x'+'9'.repeat(40);
  assert.throws(() => checkSnapshot(forged,registry,SLOT));
});
test('snapshot with missing household fails', () => {
  const fewer=structuredClone(snapshot); fewer.users.pop();
  assert.throws(() => checkSnapshot(fewer,registry,SLOT));
});
test('B09 created or unchanged responses are accepted', () => {
  for (const created of [0,2]) {
    assert.equal(checkImportResult({source:'energy-snapshot',snapshotId:SID,timeSlot:SLOT,total:2,created,unchanged:2-created},snapshot).created,created);
  }
});
test('partial import response cannot pass', () => {
  assert.throws(() => checkImportResult({source:'energy-snapshot',snapshotId:SID,timeSlot:SLOT,total:2,created:1,unchanged:1},snapshot));
});
test('PostgreSQL verification accepts exact bigint data', () => assert.equal(checkStoredSnapshot(snapshot,batch,stored(),wallets),2));
test('PostgreSQL verification fails if a bigint quantity differs', () => {
  const rows=stored();rows[0].netEnergyWh=2001n;
  assert.throws(() => checkStoredSnapshot(snapshot,batch,rows,wallets));
});
test('PostgreSQL verification rejects missing row', () => assert.throws(() => checkStoredSnapshot(snapshot,batch,stored().slice(0,1),wallets)));
test('PostgreSQL verification rejects changed trusted wallet', () => {
  const altered=structuredClone(wallets);altered[0].wallet.evmAddress='0x'+'9'.repeat(40);
  assert.throws(() => checkStoredSnapshot(snapshot,batch,stored(),altered));
});
test('PostgreSQL verification rejects missing metadata', () => assert.throws(() => checkStoredSnapshot(snapshot,null,stored(),wallets)));

test('CLI cannot expect more users than its safety cap', () => assert.throws(() => parseArgs(['--registry','reg.json','--time-slot',SLOT,'--expected-users','13'])));
