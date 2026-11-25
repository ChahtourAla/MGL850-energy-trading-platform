import { Interface, TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers';

export type B27ProofInput = {
  allocationId: string;
  marketId: string;
  buyerAddress: string;
  sellerAddress: string;
  quantityWh: bigint;
  unitPriceMicrousdPerKwh: bigint;
  amountBaseUnits: bigint;
  /** Optional for legacy exact-only test fixtures. Required for B28 half-even. */
  pricingVersion?: string;
  remainder?: number;
  intent: null | {
    chainId: number;
    status: string;
    tokenAddress: string;
    contractAddress: string | null;
    amountBaseUnits: bigint;
    evidence: null | {
      chainId: number;
      receiptStatus: string;
      verificationStatus: string;
      txHash: string;
      contractAddress: string;
      tokenAddress: string;
      buyerAddress: string;
      sellerAddress: string;
      amountBaseUnits: bigint;
      logIndex: number;
    };
  };
};

export type B27ProofResult = {
  readOnly: true;
  status: string;
  reason: string;
  confirmedPaymentBaseUnits: string | null;
  transactionHash: string | null;
  explorerUrl: string | null;
  checkedAt: string | null;
};

type Dependencies = {
  rpcUrl?: string;
  expectedTokenAddress?: string;
  expectedSettlementAddress?: string;
  rpc?: (method: string, params: unknown[]) => Promise<unknown>;
  mirrorTransactionId?: (hash: string) => Promise<string | null>;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

const FIELDS = [
  { name: 'token', type: 'address' },
  { name: 'marketId', type: 'bytes32' },
  { name: 'snapshotHash', type: 'bytes32' },
  { name: 'planCommitment', type: 'bytes32' },
  { name: 'allocationId', type: 'bytes32' },
  { name: 'buyer', type: 'address' },
  { name: 'seller', type: 'address' },
  { name: 'quantityWh', type: 'uint256' },
  { name: 'unitPriceMicrousdPerKwh', type: 'uint256' },
  { name: 'amountBaseUnits', type: 'uint256' },
  { name: 'algorithmId', type: 'bytes32' },
  { name: 'pricingPolicyId', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

const settlementAbi = new Interface([
  'function settle((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s,bytes signature)',
  'event EnergyPaymentSettled(bytes32 indexed settlementId,bytes32 indexed marketId,bytes32 indexed allocationId,bytes32 snapshotHash,bytes32 planCommitment,address buyer,address seller,address token,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce)',
]);

const tokenAbi = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

function same(a: unknown, b: unknown, pattern = ADDRESS): boolean {
  return typeof a === 'string' &&
    typeof b === 'string' &&
    pattern.test(a) &&
    pattern.test(b) &&
    a.toLowerCase() === b.toLowerCase();
}

function integer(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;

  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    return BigInt(value);
  }

  if (
    typeof value === 'string' &&
    /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)
  ) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** B28 rounding is validated against the authoritative version and the raw remainder. */
function matchesAuthoritativePayment(input: B27ProofInput): boolean {
  const product = input.quantityWh * input.unitPriceMicrousdPerKwh;
  if (input.quantityWh <= 0n || input.unitPriceMicrousdPerKwh <= 0n || input.amountBaseUnits <= 0n) return false;
  if (input.pricingVersion === 'b28-teusd-half-even-1') {
    const whole = product / 1000n;
    const remainder = product % 1000n;
    const expected = whole + ((remainder > 500n || (remainder === 500n && whole % 2n === 1n)) ? 1n : 0n);
    return typeof input.remainder === 'number' && Number.isInteger(input.remainder) && input.remainder === Number(remainder) && expected === input.amountBaseUnits;
  }
  if (input.pricingVersion !== undefined && input.pricingVersion !== 'SELLER_ASK_V1') return false;
  return product === input.amountBaseUnits * 1000n;
}

function output(status: string, reason: string): B27ProofResult {
  return {
    readOnly: true,
    status,
    reason,
    confirmedPaymentBaseUnits: null,
    transactionHash: null,
    explorerUrl: null,
    checkedAt: null,
  };
}

async function rpcRequest(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  if (![
    'eth_chainId',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_getBlockByNumber',
  ].includes(method)) {
    throw new Error('RPC method not permitted');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error('RPC request failed');
  }

  const result = object(await response.json());

  if (!result || result.error) {
    throw new Error('RPC returned an error');
  }

  return result.result;
}

/**
 * Read-only resolution of a verified EVM transaction hash into a canonical
 * HashScan Testnet transaction reference. Mirror Node contract results often
 * have a consensus `timestamp` but no `transaction_id` field.
 */
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const CONSENSUS_TIMESTAMP = /^[1-9]\d{9,}\.\d{9}$/;
const HEDERA_TRANSACTION_ID = /^0\.0\.\d+[@-][1-9]\d{9,}[.-]\d{9}$/;

/** Never resolve a URL from a result for a *different* EVM transaction. */
export function mirrorExplorerReference(
  payload: unknown,
  verifiedEvmHash: string,
): string | null {
  if (!EVM_HASH.test(verifiedEvmHash)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const body = payload as Record<string, unknown>;
  if (
    typeof body.hash !== 'string' ||
    !EVM_HASH.test(body.hash) ||
    body.hash.toLowerCase() !== verifiedEvmHash.toLowerCase()
  ) return null;

  // Consensus timestamp is present on the contract result returned by the
  // official Mirror Node for this project; it is directly supported by HashScan.
  if (typeof body.timestamp === 'string' && CONSENSUS_TIMESTAMP.test(body.timestamp)) {
    return body.timestamp;
  }
  if (typeof body.transaction_id === 'string' && HEDERA_TRANSACTION_ID.test(body.transaction_id)) {
    return body.transaction_id;
  }
  return null;
}

/** Build a URL from a strict reference only; never forward arbitrary URLs. */
export function hashscanTestnetUrl(reference: string | null): string | null {
  if (!reference || !(
    CONSENSUS_TIMESTAMP.test(reference) ||
    HEDERA_TRANSACTION_ID.test(reference)
  )) return null;
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(reference)}`;
}

async function mirrorLookup(hash: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash}`,
      { signal: AbortSignal.timeout(8000) },
    );

    if (!response.ok) return null;

    // A contract result reliably exposes the consensus timestamp, not
    // necessarily transaction_id. Both formats can identify a HashScan URL.
    return mirrorExplorerReference(await response.json(), hash);
  } catch {
    // An explorer outage must not weaken or undo receipt verification.
    return null;
  }
}

function sameField(
  type: string,
  a: unknown,
  b: unknown,
): boolean {
  if (type === 'address') return same(a, b);
  if (type === 'bytes32') return same(a, b, HASH);

  const left = integer(a);
  const right = integer(b);

  return left !== null &&
    right !== null &&
    left === right;
}

export async function verifyB27HederaTransfer(
  input: B27ProofInput,
  deps: Dependencies = {},
): Promise<B27ProofResult> {
  const intent = input.intent;

  if (!intent) {
    return output('NO_INTENT', 'No settlement intent recorded.');
  }

  if (intent.chainId !== 296) {
    return output('NOT_HEDERA', 'Not a Hedera Testnet intent.');
  }

  if (intent.status !== 'CONFIRMED') {
    return output('NOT_CONFIRMED', 'Intent is not confirmed.');
  }

  const evidence = intent.evidence;

  if (!evidence) {
    return output('NO_EVIDENCE', 'No settlement evidence recorded.');
  }

  const contract = deps.expectedSettlementAddress;
  const token = deps.expectedTokenAddress;

  // Both deployed addresses must be explicitly trusted.
  if (
    !contract ||
    !token ||
    !ADDRESS.test(contract) ||
    !ADDRESS.test(token)
  ) {
    return output(
      'NOT_CONFIGURED',
      'Expected settlement contract or TEUSD token is not configured.',
    );
  }

  if (!intent.contractAddress) {
    return output(
      'MISSING_CONTRACT_BINDING',
      'Settlement contract binding is absent.',
    );
  }

  const consistent =
    HASH.test(input.allocationId) &&
    HASH.test(input.marketId) &&
    input.quantityWh > 0n &&
    input.unitPriceMicrousdPerKwh > 0n &&
    input.amountBaseUnits > 0n &&
    matchesAuthoritativePayment(input) &&
    same(intent.contractAddress, contract) &&
    same(intent.tokenAddress, token) &&
    same(evidence.contractAddress, contract) &&
    same(evidence.tokenAddress, token) &&
    same(evidence.buyerAddress, input.buyerAddress) &&
    same(evidence.sellerAddress, input.sellerAddress) &&
    evidence.amountBaseUnits === input.amountBaseUnits &&
    intent.amountBaseUnits === input.amountBaseUnits &&
    evidence.chainId === 296 &&
    evidence.receiptStatus === 'SUCCESS' &&
    evidence.verificationStatus === 'VERIFIED' &&
    HASH.test(evidence.txHash) &&
    Number.isSafeInteger(evidence.logIndex) &&
    evidence.logIndex >= 0;

  if (!consistent) {
    return output(
      'RECORD_MISMATCH',
      'Stored settlement evidence or deployment binding differs from the allocation.',
    );
  }

  if (!deps.rpc && !deps.rpcUrl) {
    return output('UNAVAILABLE', 'Hedera RPC not configured.');
  }

  const rpc = deps.rpc ??
    ((method: string, params: unknown[]) =>
      rpcRequest(deps.rpcUrl ?? '', method, params));

  let tx: Record<string, unknown> | null;
  let receipt: Record<string, unknown> | null;
  let block: Record<string, unknown> | null;

  try {
    if (integer(await rpc('eth_chainId', [])) !== 296n) {
      return output(
        'CHAIN_MISMATCH',
        'RPC is not connected to Hedera Testnet.',
      );
    }

    tx = object(await rpc(
      'eth_getTransactionByHash',
      [evidence.txHash],
    ));

    receipt = object(await rpc(
      'eth_getTransactionReceipt',
      [evidence.txHash],
    ));

    if (!tx || !receipt) {
      return output('UNAVAILABLE', 'Transaction or receipt unavailable.');
    }

    block = object(await rpc(
      'eth_getBlockByNumber',
      [receipt.blockNumber, false],
    ));
  } catch {
    return output('UNAVAILABLE', 'Read-only Hedera RPC request failed.');
  }

  if (!tx || !receipt || !block) {
    return output('UNAVAILABLE', 'On-chain records unavailable.');
  }

  const validReceipt =
    same(tx.hash, evidence.txHash, HASH) &&
    same(receipt.transactionHash, evidence.txHash, HASH) &&
    same(tx.to, contract) &&
    same(receipt.to, contract) &&
    same(tx.blockHash, receipt.blockHash, HASH) &&
    same(block.hash, receipt.blockHash, HASH) &&
    integer(receipt.status) === 1n &&
    integer(receipt.blockNumber) !== null &&
    integer(tx.value) === 0n &&
    Array.isArray(receipt.logs);

  if (!validReceipt) {
    return output(
      'ONCHAIN_MISMATCH',
      'Transaction destination, receipt, value, or canonical block differs.',
    );
  }

  // Decode the actual call to settle(...).
  const calldata =
    typeof tx.input === 'string'
      ? tx.input
      : tx.data;

  if (typeof calldata !== 'string') {
    return output('ONCHAIN_MISMATCH', 'Settlement calldata missing.');
  }

  let terms: Record<string, unknown>;
  let expectedSettlementId: string;

  try {
    const call = settlementAbi.parseTransaction({
      data: calldata,
      value: 0n,
    });

    if (!call || call.name !== 'settle') {
      throw new Error('Incorrect settlement function');
    }

    terms = call.args[0] as unknown as Record<string, unknown>;

    const normalized: Record<string, unknown> = {};

    for (const field of FIELDS) {
      normalized[field.name] = terms[field.name];
    }

    expectedSettlementId = TypedDataEncoder.hash(
      {
        name: 'MGL850 Energy Settlement',
        version: '1',
        chainId: 296,
        verifyingContract: contract,
      },
      { Settlement: FIELDS },
      normalized,
    );
  } catch {
    return output(
      'ONCHAIN_MISMATCH',
      'Settlement calldata or EIP-712 identity is invalid.',
    );
  }

  const expectedTerms =
    same(terms.token, token) &&
    same(terms.marketId, input.marketId, HASH) &&
    same(terms.allocationId, input.allocationId, HASH) &&
    same(terms.buyer, input.buyerAddress) &&
    same(terms.seller, input.sellerAddress) &&
    integer(terms.quantityWh) === input.quantityWh &&
    integer(terms.unitPriceMicrousdPerKwh) ===
      input.unitPriceMicrousdPerKwh &&
    integer(terms.amountBaseUnits) === input.amountBaseUnits &&
    (input.pricingVersion !== 'b28-teusd-half-even-1' ||
      same(terms.pricingPolicyId, keccak256(toUtf8Bytes('b28-teusd-half-even-1')), HASH));

  if (!expectedTerms) {
    return output(
      'ONCHAIN_MISMATCH',
      'Settlement calldata does not match the authoritative allocation.',
    );
  }

  const logs = receipt.logs as unknown[];

  const settlements: Array<{
    args: Record<string, unknown>;
    logIndex: bigint | null;
  }> = [];

  const transfers: Array<{ logIndex: bigint | null }> = [];

  for (const raw of logs) {
    const log = object(raw);

    if (
      !log ||
      log.removed === true ||
      !Array.isArray(log.topics) ||
      typeof log.data !== 'string' ||
      !same(log.transactionHash, evidence.txHash, HASH)
    ) {
      continue;
    }

    try {
      if (same(log.address, contract)) {
        const decoded = settlementAbi.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });

        if (decoded?.name === 'EnergyPaymentSettled') {
          settlements.push({
            args: decoded.args as unknown as Record<string, unknown>,
            logIndex: integer(log.logIndex),
          });
        }
      }

      if (same(log.address, token)) {
        const decoded = tokenAbi.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });

        if (
          decoded?.name === 'Transfer' &&
          same(decoded.args.from, input.buyerAddress) &&
          same(decoded.args.to, input.sellerAddress) &&
          integer(decoded.args.value) === input.amountBaseUnits
        ) {
          transfers.push({
            logIndex: integer(log.logIndex),
          });
        }
      }
    } catch {
      // Malformed logs never count as matching evidence.
    }
  }

  if (settlements.length !== 1 || transfers.length !== 1) {
    return output(
      'ONCHAIN_MISMATCH',
      'Expected settlement and token transfer events are missing or ambiguous.',
    );
  }

  const payment = settlements[0];

  // The emitted event must describe exactly the decoded call.
  const eventMatches =
    same(payment.args.settlementId, expectedSettlementId, HASH) &&
    FIELDS
      .filter((field) => field.name !== 'deadline')
      .every((field) =>
        sameField(
          field.type,
          payment.args[field.name],
          terms[field.name],
        ),
      );

  if (!eventMatches) {
    return output(
      'ONCHAIN_MISMATCH',
      'EnergyPaymentSettled does not match the signed settlement terms.',
    );
  }

  // V2 stores one log index; B25 has separate settlement and
  // transfer indices. Accept the recorded index only if it
  // points to one of the two independently matched events.
  const recordedIndex = BigInt(evidence.logIndex);

  if (
    payment.logIndex !== recordedIndex &&
    transfers[0].logIndex !== recordedIndex
  ) {
    return output(
      'ONCHAIN_MISMATCH',
      'Stored log index does not match the verified receipt.',
    );
  }

  const lookup = deps.mirrorTransactionId ?? mirrorLookup;
  const mirrorReference =
    await lookup(evidence.txHash).catch(() => null);

  // The transaction was already validated against the canonical Hedera RPC
  // receipt and TEUSD events above. Only then is this display link emitted.
  const explorerUrl = hashscanTestnetUrl(mirrorReference);

  return {
    readOnly: true,
    status: 'VERIFIED_ON_CHAIN',
    reason:
      'Settlement calldata, allocation identity, canonical receipt, EnergyPaymentSettled event, and TEUSD transfer match.',
    confirmedPaymentBaseUnits: input.amountBaseUnits.toString(),
    transactionHash: evidence.txHash,
    explorerUrl,
    checkedAt: new Date().toISOString(),
  };
}
