import assert from 'node:assert/strict';

const base = process.env.B27_BACKEND_URL;
const key = process.env.TRADING_API_READ_ADMIN_KEY;

if (!base || !key) {
  throw new Error('B27 API configuration is missing');
}

const period = new URLSearchParams({
  from: '2026-11-10T00:00:00Z',
  to: '2026-11-11T00:00:00Z',
});

async function request(path) {
  const response = await fetch(new URL(path, base), {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  return {
    status: response.status,
    data: await response.json().catch(() => null),
  };
}

const usersResponse = await request('/internal/v2/demo/users');

assert.equal(usersResponse.status, 200);

const users = usersResponse.data.users;
assert.ok(Array.isArray(users));

console.log('=== B27 V2 TRADING PREFLIGHT ===');
console.log('Households:', users.length);

for (const endpoint of ['matches', 'trades']) {
  console.log(`\n--- ${endpoint.toUpperCase()} ---`);

  let totalViews = 0;
  let firstRecord = null;
  let incomplete = false;
  let responseKeys = null;

  for (const user of users) {
    const path =
      `/internal/v2/demo/users/${encodeURIComponent(user.userId)}` +
      `/${endpoint}?${period.toString()}`;

    const response = await request(path);

    if (response.status !== 200) {
      throw new Error(`${endpoint} failed for ${user.name}: ` + `HTTP ${response.status}`);
    }

    const data = response.data;
    responseKeys ??= Object.keys(data ?? {});

    if (data?.hasMore === true) {
      incomplete = true;
    }

    const rows = Array.isArray(data)
      ? data
      : (Object.values(data ?? {}).find(
          (value) => Array.isArray(value) && (value.length === 0 || typeof value[0] === 'object'),
        ) ?? []);

    totalViews += rows.length;

    if (!firstRecord && rows.length > 0) {
      firstRecord = rows[0];
    }
  }

  console.log('Response keys:', responseKeys);
  console.log('Household record views:', totalViews);
  console.log('Additional pages:', incomplete);

  if (firstRecord) {
    console.log('Record fields:', Object.keys(firstRecord));

    for (const [name, value] of Object.entries(firstRecord)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        console.log(`${name} fields:`, Object.keys(value));
      }
    }
  } else {
    console.log('No records in this period');
  }
}

console.log('\nPASS: Read-only V2 trading API inspection completed');
