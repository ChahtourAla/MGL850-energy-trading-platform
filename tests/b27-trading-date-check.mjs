import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = process.env.B27_BACKEND_URL;
const key = process.env.TRADING_API_READ_ADMIN_KEY;

if (!base || !key) {
  throw new Error('B27 API configuration missing');
}

async function request(path, params = {}) {
  const url = new URL(path, base);

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url, {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

test('B27 trading date filtering', async (t) => {
  const users = await request('/internal/v2/demo/users');

  assert.equal(users.status, 200);
  assert.ok(users.body.users.length > 0);

  const userId = users.body.users[0].userId;

  const path = `/internal/v2/demo/users/${userId}/trades`;

  const from = '2026-11-10T00:00:00Z';
  const to = '2026-11-11T00:00:00Z';

  await t.test('Valid date range', async () => {
    const result = await request(path, { from, to });

    assert.equal(result.status, 200);

    assert.equal(result.body.period.from, new Date(from).toISOString());

    assert.equal(result.body.period.to, new Date(to).toISOString());

    assert.ok(Array.isArray(result.body.trades));

    const startMs = Date.parse(from);
    const endMs = Date.parse(to);

    for (const trade of result.body.trades) {
      const intervalMs = Date.parse(trade.intervalStart);

      assert.ok(Number.isFinite(intervalMs), 'Invalid trade interval timestamp');

      assert.ok(
        intervalMs >= startMs && intervalMs < endMs,
        'Trade is outside the requested date range',
      );
    }
  });

  await t.test('Reject invalid dates', async () => {
    const cases = [
      { from: 'invalid', to },
      { from: to, to: from },
      { from },
      { to },
      {
        from,
        to: '2026-12-15T00:00:00Z',
      },
    ];

    for (const params of cases) {
      const result = await request(path, params);
      assert.equal(result.status, 400);
    }
  });

  await t.test('Preserve pagination', async () => {
    const result = await request(path, {
      from,
      to,
      limit: '10',
      offset: '0',
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.pagination.limit, 10);
    assert.equal(result.body.pagination.offset, 0);
    assert.ok(result.body.trades.length <= 10);
  });

  await t.test('Allow legacy requests without dates', async () => {
    const result = await request(path);

    assert.equal(result.status, 200);
    assert.equal(result.body.period, null);
    assert.ok(Array.isArray(result.body.trades));
  });

  console.log('B27 trading date filtering tests completed.');
});
