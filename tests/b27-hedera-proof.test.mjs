import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(
  new URL('../apps/backend/package.json', import.meta.url),
);

const { Interface, TypedDataEncoder } = require('ethers');

const { verifyB27HederaTransfer, mirrorExplorerReference, hashscanTestnetUrl } =
  await import('../apps/backend/src/b27-demo/b27-hedera-proof.ts');

const buyer = '0x' + '11'.repeat(20);
const seller = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const contract = '0x' + '44'.repeat(20);

const h = (value) => '0x' + value.repeat(64);
const txHash = h('a');
const blockHash = h('b');
const allocationId = h('1');
const marketId = h('2');

const terms = {
  token,
  marketId,
  snapshotHash: h('3'),
  planCommitment: h('4'),
  allocationId,
  buyer,
  seller,
  quantityWh: 5000n,
  unitPriceMicrousdPerKwh: 100000n,
  amountBaseUnits: 500000n,
  algorithmId: h('5'),
  pricingPolicyId: h('6'),
  nonce: 1n,
  deadline: 2000000000n,
};

const fields = [
  ['token', 'address'],
  ['marketId', 'bytes32'],
  ['snapshotHash', 'bytes32'],
  ['planCommitment', 'bytes32'],
  ['allocationId', 'bytes32'],
  ['buyer', 'address'],
  ['seller', 'address'],
  ['quantityWh', 'uint256'],
  ['unitPriceMicrousdPerKwh', 'uint256'],
  ['amountBaseUnits', 'uint256'],
  ['algorithmId', 'bytes32'],
  ['pricingPolicyId', 'bytes32'],
  ['nonce', 'uint256'],
  ['deadline', 'uint256'],
].map(([name, type]) => ({ name, type }));

const iface = new Interface([
  'function settle((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s,bytes signature)',
  'event EnergyPaymentSettled(bytes32 indexed settlementId,bytes32 indexed marketId,bytes32 indexed allocationId,bytes32 snapshotHash,bytes32 planCommitment,address buyer,address seller,address token,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce)',
]);

const tokenIface = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

function fixture() {
  const digest = TypedDataEncoder.hash(
    {
      name: 'MGL850 Energy Settlement',
      version: '1',
      chainId: 296,
      verifyingContract: contract,
    },
    { Settlement: fields },
    terms,
  );

  const transfer = tokenIface.encodeEventLog(
    tokenIface.getEvent('Transfer'),
    [buyer, seller, terms.amountBaseUnits],
  );

  const payment = iface.encodeEventLog(
    iface.getEvent('EnergyPaymentSettled'),
    [
      digest,
      marketId,
      allocationId,
      terms.snapshotHash,
      terms.planCommitment,
      buyer,
      seller,
      token,
      terms.quantityWh,
      terms.unitPriceMicrousdPerKwh,
      terms.amountBaseUnits,
      terms.algorithmId,
      terms.pricingPolicyId,
      terms.nonce,
    ],
  );

  const input = {
    allocationId,
    marketId,
    buyerAddress: buyer,
    sellerAddress: seller,
    quantityWh: terms.quantityWh,
    unitPriceMicrousdPerKwh: terms.unitPriceMicrousdPerKwh,
    amountBaseUnits: terms.amountBaseUnits,
    intent: {
      chainId: 296,
      status: 'CONFIRMED',
      tokenAddress: token,
      contractAddress: contract,
      amountBaseUnits: terms.amountBaseUnits,
      evidence: {
        chainId: 296,
        receiptStatus: 'SUCCESS',
        verificationStatus: 'VERIFIED',
        txHash,
        contractAddress: contract,
        tokenAddress: token,
        buyerAddress: buyer,
        sellerAddress: seller,
        amountBaseUnits: terms.amountBaseUnits,
        logIndex: 2,
      },
    },
  };

  const tx = {
    hash: txHash,
    to: contract,
    blockHash,
    value: '0x0',
    input: iface.encodeFunctionData(
      'settle',
      [terms, '0x' + '11'.repeat(65)],
    ),
  };

  const receipt = {
    transactionHash: txHash,
    to: contract,
    status: '0x1',
    blockHash,
    blockNumber: '0x5',
    logs: [
      {
        address: token,
        topics: transfer.topics,
        data: transfer.data,
        transactionHash: txHash,
        logIndex: '0x2',
        removed: false,
      },
      {
        address: contract,
        topics: payment.topics,
        data: payment.data,
        transactionHash: txHash,
        logIndex: '0x3',
        removed: false,
      },
    ],
  };

  const chain = { id: '0x128' };
  const block = { hash: blockHash };

  const deps = {
    expectedTokenAddress: token,
    expectedSettlementAddress: contract,
    mirrorTransactionId: async () => null,

    rpc: async (method) => {
      if (method === 'eth_chainId') return chain.id;
      if (method === 'eth_getTransactionByHash') return tx;
      if (method === 'eth_getTransactionReceipt') return receipt;
      if (method === 'eth_getBlockByNumber') return block;
      throw Error('Unexpected RPC method');
    },
  };

  return { input, deps, tx, receipt, chain, block };
}

async function check(f) {
  return verifyB27HederaTransfer(f.input, f.deps);
}

test('verifies actual settlement contract route', async () => {
  const f = fixture();
  const result = await check(f);

  assert.equal(result.status, 'VERIFIED_ON_CHAIN');
  assert.equal(result.confirmedPaymentBaseUnits, '500000');
  assert.equal(result.explorerUrl, null);
});

test('rejects wrong settlement contract destination', async () => {
  const f = fixture();
  f.tx.to = token;

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects missing settlement event', async () => {
  const f = fixture();
  f.receipt.logs.pop();

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects missing TEUSD transfer', async () => {
  const f = fixture();
  f.receipt.logs.shift();

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects failed settlement receipt', async () => {
  const f = fixture();
  f.receipt.status = '0x0';

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects noncanonical block', async () => {
  const f = fixture();
  f.block.hash = h('f');

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects incorrect network', async () => {
  const f = fixture();
  f.chain.id = '0x7a69';

  assert.equal((await check(f)).status, 'CHAIN_MISMATCH');
});

test('rejects incorrect allocation identity', async () => {
  const f = fixture();
  f.input.allocationId = h('9');

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('rejects incorrect energy quantity', async () => {
  const f = fixture();
  f.input.quantityWh = 6000n;

  assert.equal((await check(f)).status, 'RECORD_MISMATCH');
});

test('rejects inconsistent stored amount', async () => {
  const f = fixture();
  f.input.intent.evidence.amountBaseUnits = 100n;

  assert.equal((await check(f)).status, 'RECORD_MISMATCH');
});

test('requires trusted settlement deployment', async () => {
  const f = fixture();
  f.deps.expectedSettlementAddress = undefined;

  assert.equal((await check(f)).status, 'NOT_CONFIGURED');
});

test('requires contract binding', async () => {
  const f = fixture();
  f.input.intent.contractAddress = null;

  assert.equal((await check(f)).status, 'MISSING_CONTRACT_BINDING');
});

test('rejects unrelated recorded log index', async () => {
  const f = fixture();
  f.input.intent.evidence.logIndex = 99;

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('supports settlement-event log index', async () => {
  const f = fixture();
  f.input.intent.evidence.logIndex = 3;

  assert.equal((await check(f)).status, 'VERIFIED_ON_CHAIN');
});

test('rejects direct token transaction', async () => {
  const f = fixture();
  f.tx.to = token;
  f.receipt.to = token;

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});

test('requires matching settlement market', async () => {
  const f = fixture();
  f.input.marketId = h('8');

  assert.equal((await check(f)).status, 'ONCHAIN_MISMATCH');
});


test('emits HashScan consensus timestamp only after verified TEUSD receipt', async () => {
  const f = fixture();
  f.deps.mirrorTransactionId = async () => '1795415309.464626984';
  const result = await check(f);
  assert.equal(result.status, 'VERIFIED_ON_CHAIN');
  assert.equal(result.explorerUrl, 'https://hashscan.io/testnet/transaction/1795415309.464626984');

  f.receipt.status = '0x0';
  const failed = await check(f);
  assert.equal(failed.status, 'ONCHAIN_MISMATCH');
  assert.equal(failed.explorerUrl, null);
});

test('still supports Hedera transaction IDs and rejects invented URLs', async () => {
  const f = fixture();
  f.deps.mirrorTransactionId = async () => '0.0.12345@1795415309.464626984';
  assert.equal((await check(f)).explorerUrl,
    'https://hashscan.io/testnet/transaction/0.0.12345%401795415309.464626984');
  f.deps.mirrorTransactionId = async () => 'https://evil.test/transaction/1';
  assert.equal((await check(f)).explorerUrl, null);
});


test('actual Mirror Node result without transaction_id resolves via timestamp', () => {
  const r = mirrorExplorerReference({hash: txHash, timestamp: '1795415309.464626984', transaction_id: null}, txHash);
  assert.equal(hashscanTestnetUrl(r), 'https://hashscan.io/testnet/transaction/1795415309.464626984');
  assert.equal(mirrorExplorerReference({hash: blockHash, timestamp: '1795415309.464626984'}, txHash), null);
});

test('real Mirror Node adapter uses timestamp response, not missing transaction_id', async () => {
  const f = fixture();
  delete f.deps.mirrorTransactionId;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${txHash}`);
    return { ok: true, json: async () => ({ hash: txHash, timestamp: '1795415309.464626984', transaction_id: null }) };
  };
  try {
    assert.equal((await check(f)).explorerUrl, 'https://hashscan.io/testnet/transaction/1795415309.464626984');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
