import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closedHours,eligibleEnd} from './b26-utc-hours.mjs';
const d = value => new Date(value);

test('discovers 24 distinct closed UTC hours with a bounded batch', () => {
 const hours = closedHours({from:d('2024-02-28T00:00:00Z'),now:d('2024-02-29T00:01:00Z'),limit:24});
 assert.equal(hours.length,24);
 assert.equal(new Set(hours.map(h => h.start.toISOString())).size,24);
 assert.equal(hours[23].end.toISOString(),'2024-02-29T00:00:00.000Z');
 assert.equal(closedHours({from:hours[0].start,now:hours[23].end,limit:3}).length,3);
});
test('grace, partially elapsed hours, and future intervals fail closed', () => {
 assert.equal(eligibleEnd(d('2026-03-08T07:04:59Z'),300000).toISOString(),'2026-03-08T06:00:00.000Z');
 assert.equal(eligibleEnd(d('2026-03-08T07:05:00Z'),300000).toISOString(),'2026-03-08T07:00:00.000Z');
 assert.equal(closedHours({from:d('2026-03-08T07:00:00Z'),now:d('2026-03-08T07:59:59Z')}).length,0);
});
test('UTC boundaries are independent of daylight saving and month changes', () => {
 const hours=closedHours({from:d('2024-03-10T05:00:00Z'),now:d('2024-03-10T09:00:00Z')});
 assert.deepEqual(hours.map(h=>h.start.getUTCHours()),[5,6,7,8]);
 const month=closedHours({from:d('2024-02-29T23:00:00Z'),now:d('2024-03-01T01:00:00Z')});
 assert.equal(month[1].start.toISOString(),'2024-03-01T00:00:00.000Z');
});
test('rejects invalid time, unaligned starts and unbounded batches', () => {
 assert.throws(()=>closedHours({from:d('2026-01-01T00:01:00Z'),now:new Date()}),/aligned/);
 assert.throws(()=>eligibleEnd(new Date(NaN)),/valid Date/);
 assert.throws(()=>eligibleEnd(new Date(),-1),/nonnegative/);
 assert.throws(()=>closedHours({from:d('2026-01-01T00:00:00Z'),now:new Date(),limit:1001}),/limit/);
});
