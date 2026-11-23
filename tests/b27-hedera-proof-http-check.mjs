import assert from "node:assert/strict";
import { test } from "node:test";

const base = process.env.B27_BACKEND_URL;
const key = process.env.TRADING_API_READ_ADMIN_KEY;

if (!base || !key) {
  throw new Error(
    "Missing B27_BACKEND_URL or TRADING_API_READ_ADMIN_KEY"
  );
}

async function request(path, authenticated = true) {
  const headers = authenticated
    ? { "x-trading-read-key": key }
    : {};

  const response = await fetch(
    new URL(path, base),
    {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    }
  );

  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

test("B27 Hedera verification HTTP integration", async (t) => {
  const usersResponse = await request(
    "/internal/v2/demo/users"
  );

  assert.equal(usersResponse.status, 200);
  assert.ok(
    Array.isArray(usersResponse.body?.users)
  );

  const users = usersResponse.body.users;
  assert.ok(users.length > 0);

  const userId = users[0].userId;

  const route =
    `/internal/v2/demo/users/${userId}` +
    `/trades/b27-missing-allocation-000/verification`;

  await t.test(
    "Reject unauthenticated requests",
    async () => {
      const result = await request(route, false);

      assert.ok(
        [401, 403].includes(result.status),
        `Unexpected status: ${result.status}`
      );
    }
  );

  await t.test(
    "Reject malformed allocation identifiers",
    async () => {
      const path =
        `/internal/v2/demo/users/${userId}` +
        `/trades/invalid!allocation/verification`;

      const result = await request(path);

      assert.equal(result.status, 400);
    }
  );

  await t.test(
    "Reject allocations that do not exist",
    async () => {
      const result = await request(route);

      assert.equal(result.status, 404);
    }
  );

  await t.test(
    "Reject unknown household",
    async () => {
      const unknown =
        "00000000-0000-4000-8000-000000000000";

      const path =
        `/internal/v2/demo/users/${unknown}` +
        `/trades/b27-missing-allocation-000/verification`;

      const result = await request(path);

      assert.equal(result.status, 404);
    }
  );

  await t.test(
    "Inspect real V2 allocations without making payments",
    async () => {
      let allocations = 0;
      let verificationRequests = 0;

      for (const user of users) {
        const path =
          `/internal/v2/demo/users/${user.userId}/trades` +
          `?limit=50&offset=0`;

        const history = await request(path);

        assert.equal(history.status, 200);
        assert.ok(Array.isArray(history.body.trades));

        const trades = history.body.trades;

        allocations += trades.length;

        for (const trade of trades) {
          const verificationPath =
            `/internal/v2/demo/users/${user.userId}` +
            `/trades/${encodeURIComponent(trade.allocationId)}` +
            `/verification`;

          const result = await request(verificationPath);

          assert.equal(result.status, 200);
          assert.equal(result.body.readOnly, true);
          assert.equal(
            result.body.allocationId,
            trade.allocationId
          );

          assert.equal(
            typeof result.body.status,
            "string"
          );

          if (result.body.status === "VERIFIED_ON_CHAIN") {
            assert.match(
              result.body.transactionHash,
              /^0x[a-fA-F0-9]{64}$/
            );

            assert.match(
              result.body.confirmedPaymentBaseUnits,
              /^\d+$/
            );
          }

          verificationRequests++;
        }
      }

      console.log("\n=== V2 EVIDENCE INVENTORY ===");
      console.log("Households:", users.length);
      console.log("Household trade views:", allocations);
      console.log(
        "Verification requests:",
        verificationRequests
      );
      console.log("Payment execution: DISABLED");

      if (allocations === 0) {
        console.log(
          "Non-empty allocation verification: NOT TESTED"
        );
      }
    }
  );
});
