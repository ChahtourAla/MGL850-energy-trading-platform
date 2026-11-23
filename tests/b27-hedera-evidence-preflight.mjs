import assert from 'node:assert/strict';

const backendUrl = process.env.B27_BACKEND_URL;
const readKey = process.env.TRADING_API_READ_ADMIN_KEY;
const rpcUrl = process.env.HEDERA_JSON_RPC_URL;
const escrowAddress = process.env.ENERGY_TRADING_CONTRACT_ADDRESS;

if (!backendUrl || !readKey) {
  throw new Error('Missing B27_BACKEND_URL or TRADING_API_READ_ADMIN_KEY');
}

if (escrowAddress && !/^0x[a-fA-F0-9]{40}$/.test(escrowAddress)) {
  throw new Error('Invalid escrow contract address');
}

// Read data from our secured NestJS API.
async function api(path) {
  const response = await fetch(new URL(path, backendUrl), {
    headers: {
      'x-trading-read-key': readKey,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`B27 API returned HTTP ${response.status}`);
  }

  return response.json();
}

// Only allow read-only JSON-RPC methods.
async function rpc(method, params = []) {
  const allowed = new Set(['eth_chainId', 'eth_getTransactionReceipt']);

  if (!allowed.has(method)) {
    throw new Error('RPC method not allowed');
  }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw new Error(`Hedera RPC returned HTTP ${response.status}`);
  }

  const body = await response.json();

  if (body.error) {
    throw new Error(`Hedera RPC failed: ${body.error.code ?? 'unknown'}`);
  }

  return body.result;
}

// Read all households.
const usersResult = await api('/internal/v2/demo/users');

assert.ok(Array.isArray(usersResult.users));

const query = new URLSearchParams({
  from: '2026-11-10T00:00:00Z',
  to: '2026-11-11T00:00:00Z',
});

const matches = new Map();
let operationCount = 0;

for (const user of usersResult.users) {
  const result = await api(
    `/internal/v2/demo/users/` + `${encodeURIComponent(user.userId)}` + `/lifecycle?${query}`,
  );

  assert.equal(result.hasMore, false, `Incomplete history for ${user.name}`);

  for (const item of result.items) {
    const existing = matches.get(item.matchId);

    if (existing) {
      assert.deepEqual(existing.trade, item.trade, 'Buyer/seller trade mismatch');

      assert.deepEqual(existing.events, item.events, 'Buyer/seller journal mismatch');

      continue;
    }

    matches.set(item.matchId, item);
    operationCount += item.events.length;
  }
}

// Collect transaction hashes without duplicates.
const txHashes = new Map();
let nonEvmIdentifiers = 0;
let trades = 0;

for (const item of matches.values()) {
  if (item.trade) {
    trades++;
  }

  for (const event of item.events) {
    if (event.chainId !== null && event.chainId !== 296) {
      throw new Error(`Unexpected journal chain ID: ${event.chainId}`);
    }

    if (!event.transactionHash) {
      continue;
    }

    // Only EVM-format hashes can be checked
    // using eth_getTransactionReceipt.
    if (!/^0x[a-fA-F0-9]{64}$/.test(event.transactionHash)) {
      nonEvmIdentifiers++;
      continue;
    }

    const hash = event.transactionHash.toLowerCase();
    const details = txHashes.get(hash) ?? [];

    details.push({
      source: event.source,
      operation: event.operation,
      matchId: item.matchId,
    });

    txHashes.set(hash, details);
  }
}

console.log('=== B27.3 EVIDENCE INVENTORY ===');
console.log('Households:', usersResult.users.length);
console.log('Unique matches:', matches.size);
console.log('Local trade records:', trades);
console.log('Journal operations:', operationCount);
console.log('Unique EVM hashes:', txHashes.size);
console.log('Non-EVM transaction identifiers:', nonEvmIdentifiers);

// Avoid unexpectedly requesting hundreds of receipts.
if (txHashes.size > 50) {
  throw new Error('More than 50 hashes: use paginated verification');
}

// Confirm that we are connected to Hedera Testnet.
if (rpcUrl) {
  const chainId = Number(BigInt(await rpc('eth_chainId')));

  assert.equal(chainId, 296, 'RPC is not connected to Hedera Testnet');

  console.log('RPC chain ID: 296');
} else if (txHashes.size > 0) {
  throw new Error('Set HEDERA_JSON_RPC_URL to check receipts');
} else {
  console.log('RPC not configured; no EVM hashes to inspect.');
}

// Check recorded transactions against the network.
for (const [hash, details] of txHashes) {
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);

  const shortHash = `${hash.slice(0, 12)}...${hash.slice(-6)}`;

  const operations = [...new Set(details.map((detail) => detail.operation))].join(', ');

  if (receipt === null) {
    console.log(`${shortHash} [${operations}]: RECEIPT_NOT_FOUND`);
    continue;
  }

  assert.equal(receipt.transactionHash?.toLowerCase(), hash, 'Receipt hash mismatch');

  const status =
    receipt.status === '0x1'
      ? 'EXECUTION_SUCCESS'
      : receipt.status === '0x0'
        ? 'EXECUTION_FAILED'
        : 'RECEIPT_STATUS_UNKNOWN';

  const escrowLogs = escrowAddress
    ? (receipt.logs ?? []).filter(
        (log) => log.address?.toLowerCase() === escrowAddress.toLowerCase(),
      ).length
    : 'not-checked';

  console.log(`${shortHash} [${operations}]: ${status}; ` + `escrow logs=${escrowLogs}`);
}

console.log('Settlement proof: NOT ASSESSED.');

console.log('A successful receipt alone is not proof of payment.');

console.log('B27.3 preflight inventory completed (read-only).');
