import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readB27LiveTokenBalance } from '../apps/backend/src/b27-demo/b27-live-token-balance.ts';

const token = '0x5B529135D699244D1247877353EaFdC429892bed';
const wallet = '0x133b23B613209cA21ea8A6138f7215c288E5C99F';
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
function fixture() {
  const methods = [];
  const deps = {
    expectedTokenAddress: token,
    rpc: async (method, params) => {
      methods.push(method);
      if (method === 'eth_chainId') return '0x128';
      if (method === 'eth_blockNumber') return '0x101';
      if (method === 'eth_getCode') return '0x60016000';
      if (method === 'eth_call') {
        assert.equal(params[1], '0x101');
        const data = params[0].data;
        if (data === '0x313ce567') return word(6);
        if (data.startsWith('0x70a08231')) return word(100_000_000);
      }
      throw Error(`Unexpected RPC method ${method}`);
    },
  };
  return { deps, methods };
}

test('reads an exact 100 TEUSD at one pinned block', async () => {
  const f = fixture();
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'VERIFIED_ON_CHAIN');
  assert.equal(result.onChainBalanceBaseUnits, '100000000');
  assert.equal(result.chainId, 296);
  assert.equal(result.blockNumber, '257');
  assert.deepEqual(f.methods.sort(), ['eth_blockNumber','eth_call','eth_call','eth_chainId','eth_getCode'].sort());
});

test('missing wallet never reads RPC', async () => {
  const f = fixture();
  const result = await readB27LiveTokenBalance(null, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
  assert.equal(result.onChainBalanceBaseUnits, null);
  assert.equal(f.methods.length, 0);
});

test('wrong chain never returns a balance', async () => {
  const f = fixture();
  f.deps.rpc = async (method) => method === 'eth_chainId' ? '0x7a69' : word(6);
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
  assert.equal(result.onChainBalanceBaseUnits, null);
});

test('rejects wrong token decimals', async () => {
  const f = fixture();
  const original = f.deps.rpc;
  f.deps.rpc = async (method, params) =>
    method === 'eth_call' && params[0].data === '0x313ce567'
      ? word(18)
      : original(method, params);
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
});

test('rejects missing bytecode', async () => {
  const f = fixture();
  const original = f.deps.rpc;
  f.deps.rpc = async (method, params) =>
    method === 'eth_getCode' ? '0x' : original(method, params);
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
});

test('rejects malformed contract balance', async () => {
  const f = fixture();
  const original = f.deps.rpc;
  f.deps.rpc = async (method, params) =>
    method === 'eth_call' && params[0].data.startsWith('0x70a08231')
      ? '0xgarbage'
      : original(method, params);
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
});

test('does not invent a balance during RPC failure', async () => {
  const f = fixture();
  f.deps.rpc = async () => { throw Error('RPC offline'); };
  const result = await readB27LiveTokenBalance(wallet, f.deps);
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
  assert.equal(result.onChainBalanceBaseUnits, null);
});

test('missing configuration is not verified', async () => {
  const result = await readB27LiveTokenBalance(wallet, {});
  assert.equal(result.balanceStatus, 'NOT_VERIFIED');
});
