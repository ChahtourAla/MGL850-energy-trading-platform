import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = process.env.B27_BACKEND_URL;
const adminKey = process.env.TRADING_API_READ_ADMIN_KEY;

if (!baseUrl || !adminKey) {
  throw new Error('Set B27_BACKEND_URL and TRADING_API_READ_ADMIN_KEY.');
}

const from = '2026-11-10T00:00:00Z';
const to = '2026-11-11T00:00:00Z';

async function get(path, key = adminKey) {
  const url = new URL(path, baseUrl);

  const response = await fetch(url, {
    headers: key === null ? {} : { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    data: await response.json().catch(() => null),
  };
}

const period = new URLSearchParams({ from, to }).toString();

const lifecyclePath = (userId) =>
  `/internal/v2/demo/users/${encodeURIComponent(userId)}` + `/lifecycle?${period}`;

test('B27 cross-household lifecycle integrity', async (t) => {
  const usersResponse = await get('/internal/v2/demo/users');

  assert.equal(usersResponse.status, 200);
  assert.ok(Array.isArray(usersResponse.data?.users));

  const users = usersResponse.data.users;

  const namesById = new Map(users.map((user) => [user.userId, user.name]));

  assert.equal(namesById.size, users.length, 'Duplicate household IDs');

  assert.equal(users.length, 12, 'Expected the 12 B12 demo households');

  const viewsByMatchId = new Map();
  let totalViews = 0;

  await t.test('Read all household lifecycle records', async () => {
    for (const user of users) {
      const response = await get(lifecyclePath(user.userId));

      assert.equal(response.status, 200, `Lifecycle failed for ${user.name}`);

      assert.match(response.cacheControl ?? '', /no-store/i);

      const data = response.data;

      assert.equal(data.user?.id, user.userId);
      assert.equal(data.readOnly, true);
      assert.equal(data.hasMore, false, `${user.name} has additional untested pages`);

      assert.ok(Array.isArray(data.items));

      const localMatchIds = new Set();

      for (const item of data.items) {
        assert.ok(!localMatchIds.has(item.matchId), `Duplicate match for ${user.name}`);

        localMatchIds.add(item.matchId);

        const timestamp = Date.parse(item.intervalStart);

        assert.ok(
          Number.isFinite(timestamp) && timestamp >= Date.parse(from) && timestamp < Date.parse(to),
          'Match is outside the requested period',
        );

        assert.ok(BigInt(item.quantityWh) > 0n);
        assert.ok(BigInt(item.quotedAmountMicrousd) >= 0n);

        assert.equal(item.paymentVerification, 'NOT_INDEPENDENTLY_VERIFIED');

        assert.equal(item.explorerUrl, null);
        assert.ok(Array.isArray(item.events));

        const expectedStage = !item.trade
          ? 'MATCH_ONLY'
          : item.events.length === 0
            ? 'TRADE_RECORDED'
            : 'OPERATIONS_RECORDED';

        assert.equal(item.lifecycleStage, expectedStage);

        const views = viewsByMatchId.get(item.matchId) ?? [];

        views.push({
          userId: user.userId,
          userName: user.name,
          item,
        });

        viewsByMatchId.set(item.matchId, views);
        totalViews++;
      }
    }
  });

  await t.test('Every match has consistent buyer and seller records', () => {
    for (const [matchId, views] of viewsByMatchId) {
      assert.equal(views.length, 2, `${matchId} must appear for two households`);

      const buyer = views.find((view) => view.item.side === 'BOUGHT');

      const seller = views.find((view) => view.item.side === 'SOLD');

      assert.ok(buyer && seller, `${matchId} has missing buyer or seller`);

      assert.notEqual(buyer.userId, seller.userId, 'Self-trade detected');

      assert.equal(buyer.item.counterparty, namesById.get(seller.userId));

      assert.equal(seller.item.counterparty, namesById.get(buyer.userId));

      assert.equal(buyer.item.intervalStart, seller.item.intervalStart);

      assert.equal(buyer.item.quantityWh, seller.item.quantityWh);

      assert.equal(buyer.item.quotedAmountMicrousd, seller.item.quotedAmountMicrousd);

      assert.equal(buyer.item.matchingStatus, seller.item.matchingStatus);

      assert.deepEqual(buyer.item.trade, seller.item.trade);

      assert.deepEqual(buyer.item.events, seller.item.events);
    }
  });

  await t.test('Verify all 17 B12 matches', () => {
    assert.equal(viewsByMatchId.size, 17);
    assert.equal(totalViews, 34);

    console.log(`Verified ${viewsByMatchId.size} matches ` + `across ${users.length} households`);
  });

  await t.test('Lifecycle requires a valid admin key', async () => {
    const path = lifecyclePath(users[0].userId);

    const missing = await get(path, null);
    const invalid = await get(path, 'invalid-b27-test-key');

    assert.ok([401, 403].includes(missing.status));

    assert.ok([401, 403].includes(invalid.status));
  });
});
