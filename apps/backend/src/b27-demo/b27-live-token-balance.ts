/**
 * B27 read-only TEUSD balance verifier. Never signs or broadcasts transactions.
 * Pins chain and a single block for the ERC-20 code/decimals/balance reads.
 */
export type B27BalanceResult = {
  balanceStatus: 'VERIFIED_ON_CHAIN' | 'NOT_VERIFIED';
  onChainBalanceBaseUnits: string | null;
  tokenAddress: string | null;
  chainId: 296 | null;
  blockNumber: string | null;
  checkedAt: string | null;
  reason: string;
};

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Dependencies = {
  rpcUrl?: string;
  expectedTokenAddress?: string;
  rpc?: Rpc;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ABI_WORD = /^0x[0-9a-fA-F]{64}$/;

function unavailable(reason: string): B27BalanceResult {
  return {
    balanceStatus: 'NOT_VERIFIED',
    onChainBalanceBaseUnits: null,
    tokenAddress: null,
    chainId: null,
    blockNumber: null,
    checkedAt: null,
    reason,
  };
}

async function readRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call']);
  if (!allowed.has(method)) throw new Error('RPC method disallowed');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('RPC HTTP failure');
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (!body || body.error || body.result === undefined) {
    throw new Error('RPC response invalid');
  }
  return body.result;
}

function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function parseWord(value: unknown): bigint | null {
  if (typeof value !== 'string' || !ABI_WORD.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

export async function readB27LiveTokenBalance(
  walletAddress: string | null,
  deps: Dependencies = {},
): Promise<B27BalanceResult> {
  if (!walletAddress || !ADDRESS.test(walletAddress)) {
    return unavailable('Household does not have a valid registered EVM wallet.');
  }
  const token = deps.expectedTokenAddress;
  if (!token || !ADDRESS.test(token) || !deps.rpc && !deps.rpcUrl) {
    return unavailable('Hedera RPC or trusted TEUSD address not configured.');
  }

  const rpc = deps.rpc ??
    ((method: string, params: unknown[]) => readRpc(deps.rpcUrl ?? '', method, params));

  try {
    const chainId = parseQuantity(await rpc('eth_chainId', []));
    if (chainId !== 296n) return unavailable('RPC network is not Hedera Testnet (296).');

    const rawBlock = await rpc('eth_blockNumber', []);
    const block = parseQuantity(rawBlock);
    if (block === null || typeof rawBlock !== 'string') {
      return unavailable('Could not pin a valid Hedera block.');
    }

    const bytecode = await rpc('eth_getCode', [token, rawBlock]);
    if (typeof bytecode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) {
      return unavailable('Configured TEUSD token has no readable contract bytecode.');
    }

    const balanceOfCalldata =
      `0x70a08231${walletAddress.slice(2).toLowerCase().padStart(64, '0')}`;

    const [rawDecimals, rawBalance] = await Promise.all([
      rpc('eth_call', [{ to: token, data: '0x313ce567' }, rawBlock]),
      rpc('eth_call', [{ to: token, data: balanceOfCalldata }, rawBlock]),
    ]);

    if (parseWord(rawDecimals) !== 6n) {
      return unavailable('Configured TEUSD contract does not report 6 decimals.');
    }
    const balance = parseWord(rawBalance);
    if (balance === null) {
      return unavailable('Hedera returned an invalid ERC-20 balance result.');
    }

    return {
      balanceStatus: 'VERIFIED_ON_CHAIN',
      onChainBalanceBaseUnits: balance.toString(),
      tokenAddress: token,
      chainId: 296,
      blockNumber: block.toString(),
      checkedAt: new Date().toISOString(),
      reason: 'ERC-20 balanceOf() was read from Hedera Testnet at the reported block.',
    };
  } catch {
    // Never invent a balance, and never leak RPC URLs or exception internals.
    return unavailable('Live Hedera balance check is temporarily unavailable.');
  }
}
