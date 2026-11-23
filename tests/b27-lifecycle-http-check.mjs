import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = process.env.B27_BACKEND_URL;
const adminKey = process.env.TRADING_API_READ_ADMIN_KEY;

if (!baseUrl || !adminKey) {
  throw new Error('Set B27_BACKEND_URL and TRADING_API_READ_ADMIN_KEY.');
}

const from = '2026-11-10T00:00:00Z';
const to = '2026-11-11T00:00:00Z';

async function read(path, query = {}, key = null) {
  const url = new URL(`/internal/v2/demo${path}`, baseUrl);

  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: key === null ? {} : { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    body,
  };
}

test('B27 lifecycle HTTP verification', async (t) => {
  await t.test('Reject missing admin key', async () => {
    const result = await read('/users');

    assert.ok([401, 403].includes(result.status), `Received HTTP ${result.status}`);
  });

  await t.test('Reject invalid admin key', async () => {
    const result = await read('/users', {}, 'invalid-b27-test-key');

    assert.ok([401, 403].includes(result.status), `Received HTTP ${result.status}`);
  });

  // Retrieve the real simulated households.
  const usersResult = await read('/users', {}, adminKey);

  assert.equal(usersResult.status, 200);
  assert.ok(Array.isArray(usersResult.body?.users));

  // Find Household 0005 without hardcoding its UUID.
  const household = usersResult.body.users.find(
    (user) => typeof user.name === 'string' && /\bhousehold\s*0*5\b/i.test(user.name),
  );

  assert.ok(household?.userId, 'Household 0005 not found');

  console.log(`Selected: ${household.name}`);

  const path = `/users/${encodeURIComponent(household.userId)}` + '/lifecycle';

  await t.test('Reject invalid dates', async () => {
    const invalidQueries = [
      { from: 'invalid', to },
      { from: to, to: from },
      { from, to: '2026-12-12T00:00:00Z' },
    ];

    for (const query of invalidQueries) {
      const result = await read(path, query, adminKey);

      assert.equal(result.status, 400);
    }
  });

  await t.test('Reject invalid user IDs', async () => {
    const invalid = await read('/users/not-a-uuid/lifecycle', { from, to }, adminKey);

    assert.equal(invalid.status, 400);

    const unknown = await read(
      '/users/00000000-0000-4000-8000-000000000000/lifecycle',
      { from, to },
      adminKey,
    );

    assert.equal(unknown.status, 404);
  });

  await t.test('Verify recorded lifecycle', async () => {
    const result = await read(path, { from, to }, adminKey);

    assert.equal(result.status, 200, `Lifecycle returned HTTP ${result.status}`);

    const data = result.body;

    assert.equal(data.readOnly, true);
    assert.equal(data.presenterMode, true);

    assert.equal(data.source, 'B12_B17_RECORDED_LIFECYCLE');

    assert.equal(data.user?.id, household.userId);
    assert.equal(data.hasMore, false);
    assert.ok(Array.isArray(data.items));

    assert.equal(data.items.length, 5, 'Expected 5 matches for Household 0005');

    const ids = new Set();

    for (const item of data.items) {
      assert.ok(!ids.has(item.matchId));
      ids.add(item.matchId);

      assert.match(item.quantityWh, /^\d+$/);
      assert.match(item.quotedAmountMicrousd, /^\d+$/);

      assert.ok(['BOUGHT', 'SOLD'].includes(item.side));

      assert.equal(item.paymentVerification, 'NOT_INDEPENDENTLY_VERIFIED');

      assert.equal(item.explorerUrl, null);
      assert.ok(Array.isArray(item.events));

      if (item.trade === null) {
        assert.equal(item.lifecycleStage, 'MATCH_ONLY');
      }
    }

    console.log(`Verified ${data.items.length} recorded matches`);
  });

  await t.test('Verify energy API', async () => {
    const result = await read(
      `/users/${encodeURIComponent(household.userId)}/energy`,
      { from, to },
      adminKey,
    );

    assert.equal(result.status, 200, `Energy endpoint failed: ${result.status}`);
  });
});
