import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVerifiedContractArtifacts, validateContractArtifacts,
  requireTestnetRpcUrl, parseB13Args, requirePositiveTradeId,
  requireBytes32, isAddress, serializableTrade, parseKnownReceiptLogs,
  createHederaContractReader,
} from './b13-contract-client.mjs';

const source = loadVerifiedContractArtifacts();
const address = source.EnergyTradingEscrow.address;
const token = source.TestEnergyUSD.address;
const tx = '0x' + 'ab'.repeat(32);
const clone = (value) => structuredClone(value);
const validate = (overrides = {}) => validateContractArtifacts(
  overrides.metadata || clone(source.metadata),
  overrides.ignition || {
    'EnergyTradingModule#EnergyTradingEscrow': address,
    'EnergyTradingModule#TestEnergyUSD': token,
  },
  overrides.abis || { EnergyTradingEscrow: clone(source.EnergyTradingEscrow.abi), TestEnergyUSD: clone(source.TestEnergyUSD.abi) },
);

// Config, deterministic manifests and zero-write preflight.
test('loads both canonical deployed contract addresses and ABIs', () => {
  assert.equal(source.metadata.network.chainId, 296);
  assert.ok(source.EnergyTradingEscrow.abi.length > 5);
  assert.ok(source.TestEnergyUSD.abi.length > 5);
});
test('accepts a matching Ignition export and shared deployment', () => assert.ok(validate()));
test('rejects incorrect chain id', () => {
  const m = clone(source.metadata); m.network.chainId = 295;
  assert.throws(() => validate({ metadata: m }), /Testnet/);
});
test('rejects a noncanonical ABI path', () => {
  const m = clone(source.metadata); m.contracts.TestEnergyUSD.abi = '../../other.json';
  assert.throws(() => validate({ metadata: m }), /ABI path/);
});
test('rejects changed token deployment addresses', () => {
  const m = clone(source.metadata); m.contracts.TestEnergyUSD.address = '0x' + '11'.repeat(20);
  assert.throws(() => validate({ metadata: m }), /Ignition/);
});
test('rejects an omitted escrow ABI view function', () => {
  const abis = { TestEnergyUSD: clone(source.TestEnergyUSD.abi),
    EnergyTradingEscrow: source.EnergyTradingEscrow.abi.filter(x => x.name !== 'getTrade') };
  assert.throws(() => validate({ abis }), /missing function getTrade/);
});
test('rejects an omitted declared escrow event', () => {
  const abis = { TestEnergyUSD: clone(source.TestEnergyUSD.abi),
    EnergyTradingEscrow: source.EnergyTradingEscrow.abi.filter(x => x.name !== 'TradeCreated') };
  assert.throws(() => validate({ abis }), /missing event/);
});
test('rejects changes to trade status mapping', () => {
  const m = clone(source.metadata); m.tradeStatus['4'] = 'FAILED';
  assert.throws(() => validate({ metadata: m }), /TradeStatus/);
});
test('rejects changes to event signatures in metadata', () => {
  const m = clone(source.metadata); m.events.TradeFunded = 'TradeFunded(uint256)';
  assert.throws(() => validate({ metadata: m }), /event signature/);
});
test('rejects non-read-only ABI for view function', () => {
  const abis = { TestEnergyUSD: clone(source.TestEnergyUSD.abi), EnergyTradingEscrow: clone(source.EnergyTradingEscrow.abi) };
  abis.EnergyTradingEscrow.find(x => x.name === 'getTrade').stateMutability = 'nonpayable';
  assert.throws(() => validate({ abis }), /read-only/);
});
test('accepts an HTTPS RPC URL', () => assert.equal(requireTestnetRpcUrl('https://testnet.hashio.io/api'), 'https://testnet.hashio.io/api'));
test('accepts localhost HTTP only', () => assert.equal(requireTestnetRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545'));
test('rejects remote plaintext HTTP', () => assert.throws(() => requireTestnetRpcUrl('http://example.com/'), /HTTPS/));
test('rejects embedded RPC credentials', () => assert.throws(() => requireTestnetRpcUrl('https://user:secret@example.com'), /credentials/));
test('offline is the default', () => assert.deepEqual(parseB13Args([]), { live: false, txHash: undefined, tradeId: undefined }));
test('does not accept unknown or repeated flags', () => {
  assert.throws(() => parseB13Args(['--execute']), /Unknown/);
  assert.throws(() => parseB13Args(['--live','--live']), /Repeated/);
});
test('trade lookup and receipt decoding require explicit live', () => {
  assert.throws(() => parseB13Args(['--trade-id','1']), /--live/);
  assert.throws(() => parseB13Args(['--tx-hash',tx]), /--live/);
  assert.equal(parseB13Args(['--live','--trade-id','17']).tradeId, '17');
});
test('rejects negative, zero, fractional and overflow on-chain trade IDs', () => {
  for (const x of ['0','-1','1.5',(1n << 256n).toString()]) assert.throws(() => requirePositiveTradeId(x));
  assert.equal(requirePositiveTradeId('5'), 5n);
});
test('rejects malformed bytes32', () => {
  assert.throws(() => requireBytes32('0x123'));
  assert.equal(requireBytes32(tx), tx);
});
test('rejects zero address and malformed EVM addresses', () => {
  assert.equal(isAddress('0x'+'0'.repeat(40)), false);
  assert.equal(isAddress('0xf60d732EA588499D6984179B6F60f80b2FD67e5D'), true);
});
test('serializes uint256 values as decimal strings and decodes status', () => {
  const trade = [tx, address, token, 1000n, 123456789012345678n, 123456789012345678n,
    1700000000n,1700003600n,0n,tx,0n];
  const result = serializableTrade(trade, source.metadata.tradeStatus);
  assert.equal(result.quantityWh, '1000');
  assert.equal(result.unitPriceMicrousdPerKwh, '123456789012345678');
  assert.equal(result.status, 'CREATED');
});
test('unknown trade enum value fails rather than inventing a label', () => {
  const trade = [tx, address, token, 1000n, 2n, 2n, 1700000000n,1700003600n,0n,tx,99n];
  assert.throws(() => serializableTrade(trade, source.metadata.tradeStatus), /Unknown/);
});
test('filters receipts by canonical contract address only', () => {
  const iface = { parseLog: () => ({ name:'TradeCreated', signature:'TradeCreated(uint256)',
    fragment: { inputs: [{ name: 'onChainTradeId' }] }, args: [1n] }) };
  const receipt = { status: 1, logs: [
    { address: '0x'+'11'.repeat(20), topics:[],data:'0x' },
    { address, topics:[],data:'0x',index:1 },
  ]};
  const events = parseKnownReceiptLogs(receipt, source, { EnergyTradingEscrow: iface });
  assert.equal(events.length,1);
  assert.equal(events[0].args.onChainTradeId,'1');
});
test('a reverted receipt cannot be interpreted as confirmed events', () => {
  assert.throws(() => parseKnownReceiptLogs({ status:0, logs:[] },source,{}), /not successful/);
});

function mockDeps(chain = 296n, methods = {}) {
  const provider = {
    getNetwork: async () => ({ chainId:chain }),
    getCode: async () => '0x60006000',
    getTransactionReceipt: async () => ({status:1,logs:[]}),
    destroy: () => {},
  };
  const tokenMethods = { decimals: async () => 6n, symbol: async () => 'TEUSD' };
  const escrowMethods = {
    paymentToken: async () => token,
    paused: async () => false,
    nextTradeId: async () => 1n,
    getOnChainTradeId: async () => 0n,
    OPERATOR_ROLE: async () => tx,
    hasRole: async () => true,
  };
  return {
    provider: methods.provider || provider,
    contractFactory: (addr) => addr.toLowerCase() === token.toLowerCase() ? { ...tokenMethods, ...methods.token } : { ...escrowMethods, ...methods.escrow },
    interfaceFactory: () => ({ parseLog:()=>null }),
  };
}
test('live reader rejects wrong network chain ID before contract view calls', async () => {
  const client = createHederaContractReader({rpcUrl:'http://localhost:8545'}, mockDeps(295n));
  await assert.rejects(client.verifyDeployment(), /chain ID 296/);
  client.close();
});
test('live reader verifies deployed code, token decimals and escrow link', async () => {
  const client = createHederaContractReader({rpcUrl:'http://localhost:8545'}, mockDeps());
  const state = await client.verifyDeployment();
  assert.equal(state.chainId,296); assert.equal(state.tokenDecimals,6);
  assert.equal(state.escrowPaused,false); assert.equal(state.nextTradeId,'1');
  client.close();
});
test('live reader rejects missing bytecode', async () => {
  const deps = mockDeps(); deps.provider.getCode = async addr => addr.toLowerCase() === token.toLowerCase() ? '0x' : '0x1234';
  const client = createHederaContractReader({rpcUrl:'http://localhost:8545'},deps);
  await assert.rejects(client.verifyDeployment(), /bytecode/);
  client.close();
});
test('live reader rejects wrong escrow payment token', async () => {
  const client = createHederaContractReader({rpcUrl:'http://localhost:8545'}, mockDeps(296n, {escrow:{paymentToken:async ()=>'0x'+'11'.repeat(20)}}));
  await assert.rejects(client.verifyDeployment(), /paymentToken/);
  client.close();
});
test('live reader rejects wrong payment-token decimal scale', async () => {
  const client = createHederaContractReader({rpcUrl:'http://localhost:8545'}, mockDeps(296n, {token:{decimals:async ()=>18n}}));
  await assert.rejects(client.verifyDeployment(), /six decimals/);
  client.close();
});
