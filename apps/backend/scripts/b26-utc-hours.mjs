/** UTC interval calculations. These functions never advance a clock or start financial work. */
const HOUR_MS = 3_600_000;
const MAX_BATCH = 1_000;

function instant(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${name} must be a valid Date`);
  return value.getTime();
}
function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
}

/** Latest exclusive end of an hour that is closed and past its grace period. */
export function eligibleEnd(now, graceMs = 0) {
  const time = instant(now, 'now');
  nonnegativeInteger(graceMs, 'graceMs');
  const cutoff = time - graceMs;
  if (!Number.isSafeInteger(cutoff)) throw new RangeError('cutoff outside safe range');
  const end = Math.floor(cutoff / HOUR_MS) * HOUR_MS;
  const date = new Date(end);
  if (!Number.isFinite(date.getTime())) throw new RangeError('cutoff outside Date range');
  return date;
}

/** Enumerate distinct closed UTC hours, oldest first; the caller persists progress. */
export function closedHours({from, now, graceMs = 0, limit = 100}) {
  const start = instant(from, 'from');
  if (start % HOUR_MS !== 0) throw new RangeError('from must be UTC hour aligned');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new RangeError('invalid batch limit');
  const end = eligibleEnd(now, graceMs).getTime();
  const intervals = [];
  for (let t = start; t < end && intervals.length < limit; t += HOUR_MS) {
    intervals.push({start: new Date(t), end: new Date(t + HOUR_MS)});
  }
  return intervals;
}
