import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = process.env.B27_BACKEND_URL;
const key = process.env.TRADING_API_READ_ADMIN_KEY;

if (!base || !key) {
  throw new Error('Missing B27 API configuration');
}

const period = new URLSearchParams({
  from: '2026-11-10T00:00:00Z',
  to: '2026-11-11T00:00:00Z',
});

async function read(path) {
  const response = await fetch(new URL(path, base), {
    headers: { 'x-trading-read-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);

  return response.json();
}

const userPath = (userId, endpoint) =>
  `/internal/v2/demo/users/${encodeURIComponent(userId)}` + `/${endpoint}?${period.toString()}`;

test('B27 V2 trading read-model consistency', async (t) => {
  const userResult = await read('/internal/v2/demo/users');

  assert.ok(Array.isArray(userResult.users));

  const users = userResult.users;
  const names = new Map(users.map((u) => [u.userId, u.name]));

  const views = new Map();
  let totalMatchViews = 0;
  let totalTradeViews = 0;

  await t.test('Read all V2 household records', async () => {
    assert.equal(users.length, 12);

    for (const user of users) {
      const matches = await read(userPath(user.userId, 'matches'));

      const trades = await read(userPath(user.userId, 'trades'));

      assert.ok(Array.isArray(matches.matches));
      assert.ok(Array.isArray(trades.trades));
      assert.equal(matches.hasMore, false, `Unexamined matches for ${user.name}`);

      totalTradeViews += trades.trades.length;

      const localIds = new Set();

      for (const match of matches.matches) {
        assert.ok(!localIds.has(match.matchId));
        localIds.add(match.matchId);

        assert.ok(BigInt(match.quantityWh) > 0n);
        assert.ok(BigInt(match.unitPriceMicrousdPerKwh) > 0n);
        assert.ok(BigInt(match.quotedTotalMicrousd) >= 0n);

        assert.ok(names.has(match.counterparty?.userId), 'Unknown counterparty');

        assert.notEqual(match.counterparty.userId, user.userId, 'Self-trade detected');

        // A match without a trade is not proof
        // of any completed blockchain payment.
        if (match.trade == null) {
          assert.equal(match.explorerUrl, null);

          assert.ok(
            !['VERIFIED', 'PAYMENT_VERIFIED', 'PAID', 'SETTLED'].includes(
              match.paymentVerification,
            ),
            'Uncreated trade marked as paid',
          );
        }

        const records = views.get(match.matchId) ?? [];

        records.push({
          userId: user.userId,
          match,
        });

        views.set(match.matchId, records);
        totalMatchViews++;
      }
    }
  });

  await t.test('Check both sides of every match', () => {
    for (const [matchId, records] of views) {
      assert.equal(records.length, 2, `Match ${matchId} must have two views`);

      const [a, b] = records;

      assert.notEqual(a.match.side, b.match.side);

      assert.equal(a.match.counterparty.userId, b.userId);

      assert.equal(b.match.counterparty.userId, a.userId);

      for (const field of [
        'timeSlot',
        'quantityWh',
        'unitPriceMicrousdPerKwh',
        'quotedTotalMicrousd',
        'matchingStatus',
        'algorithmVersion',
      ]) {
        assert.equal(a.match[field], b.match[field], `Inconsistent ${field} for ${matchId}`);
      }

      assert.deepEqual(a.match.trade, b.match.trade);

      assert.equal(a.match.paymentVerification, b.match.paymentVerification);
    }
  });

  await t.test('Check the expected B12 dataset', () => {
    assert.equal(views.size, 17);
    assert.equal(totalMatchViews, 34);
  });

  console.log('=== B27 V2 CONSISTENCY RESULT ===');
  console.log('Households:', users.length);
  console.log('Unique matches:', views.size);
  console.log('Matching views:', totalMatchViews);
  console.log('V2 trade views:', totalTradeViews);
  console.log('Payment execution: DISABLED');
});
