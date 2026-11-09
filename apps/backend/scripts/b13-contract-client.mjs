/**
 * B13: read-only Hedera Testnet contract interface.
 * Uses canonical shared deployment metadata + ABIs. NEVER has a signer and
 * exposes no method that submits a transaction or pays a fee.
 * No database writes. B14 will implement separately reviewed state changes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTRACTS = ['TestEnergyUSD', 'EnergyTradingEscrow'];
const REQUIRED = {
  TestEnergyUSD: {
    functions: ['decimals()', 'symbol()', 'balanceOf(address)', 'allowance(address,address)', 'hasRole(bytes32,address)', 'MINTER_ROLE()'],
    events: ['Transfer(address,address,uint256)', 'Approval(address,address,uint256)'],
  },
  EnergyTradingEscrow: {
    functions: [
      'paymentToken()', 'paused()', 'nextTradeId()', 'getTrade(uint256)',
      'getOnChainTradeId(bytes32)', 'hasRole(bytes32,address)', 'OPERATOR_ROLE()',
      'ORACLE_ROLE()', 'createTrade(bytes32,address,address,uint256,uint256,uint64,uint64)',
      'fundTrade(uint256)', 'confirmDelivery(uint256,uint256,bytes32)',
    ],
    events: [
      'TradeCreated(uint256,bytes32,address,address,uint256,uint256)',
      'TradeFunded(uint256,uint256)', 'DeliveryConfirmed(uint256,uint256,bytes32)',
      'TradeSettled(uint256,address,uint256)', 'TradeRefunded(uint256,address,uint256)',
      'TradeCancelled(uint256)', 'TradeExpired(uint256)',
    ],
  },
};
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const EXPECTED_STATUSES = ['CREATED', 'FUNDED', 'AWAITING_DELIVERY', 'DELIVERED',
  'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REFUNDED'];

export function isAddress(value) {
  return typeof value === 'string' && HEX_ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
}

export function requireTestnetRpcUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('HEDERA_TESTNET_RPC_URL is required for B13 live read');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Hedera Testnet RPC URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Hedera RPC must use HTTPS (or loopback HTTP only)');
  }
  if (url.username || url.password || url.hash || !url.hostname) {
    throw new Error('RPC URL cannot embed credentials or a fragment');
  }
  return value;
}

function signature(fragment) {
  return `${fragment.name}(${(fragment.inputs ?? []).map(x => x.type).join(',')})`;
}

function requireFragments(abi, name) {
  if (!Array.isArray(abi)) throw new Error(`${name} ABI must be an array`);
  const functions = new Map(abi.filter(x => x?.type === 'function').map(x => [signature(x), x]));
  const events = new Set(abi.filter(x => x?.type === 'event').map(signature));
  for (const method of REQUIRED[name].functions) {
    if (!functions.has(method)) throw new Error(`${name} ABI missing function ${method}`);
  }
  for (const event of REQUIRED[name].events) {
    if (!events.has(event)) throw new Error(`${name} ABI missing event ${event}`);
  }
  for (const method of ['paymentToken()', 'paused()', 'nextTradeId()', 'getTrade(uint256)', 'getOnChainTradeId(bytes32)', 'decimals()', 'symbol()']) {
    const fragment = functions.get(method);
    if (fragment && !['view', 'pure'].includes(fragment.stateMutability)) {
      throw new Error(`${name} ${method} must be read-only`);
    }
  }
}

export function validateContractArtifacts(metadata, ignition, abis) {
  if (metadata?.schemaVersion !== '1.0.0' || metadata?.network?.name !== 'hedera-testnet' ||
      metadata?.network?.chainId !== 296) {
    throw new Error('B13 supports canonical Hedera Testnet chain 296 only');
  }
  if (!ignition || typeof ignition !== 'object' || !abis) throw new Error('Missing Ignition deployment or ABIs');
  const result = {};
  for (const name of CONTRACTS) {
    const address = metadata?.contracts?.[name]?.address;
    if (!isAddress(address)) throw new Error(`Invalid ${name} address`);
    if (metadata.contracts[name].abi !== `../abis/${name}.json`) {
      throw new Error(`${name} references an unexpected ABI path`);
    }
    if (ignition[`EnergyTradingModule#${name}`]?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`${name} canonical address differs from deployed Ignition address`);
    }
    requireFragments(abis[name], name);
    result[name] = { address, abi: abis[name] };
  }
  if (result.TestEnergyUSD.address.toLowerCase() === result.EnergyTradingEscrow.address.toLowerCase()) {
    throw new Error('Token and escrow cannot share an address');
  }
  for (const [index, status] of EXPECTED_STATUSES.entries()) {
    if (metadata.tradeStatus?.[String(index)] !== status || metadata.tradeStatusValue?.[status] !== index) {
      throw new Error('TradeStatus enum mapping mismatch');
    }
  }
  for (const sig of REQUIRED.EnergyTradingEscrow.events) {
    const name = sig.slice(0, sig.indexOf('('));
    if (metadata.events?.[name] !== sig) throw new Error(`Deployment event signature mismatch: ${name}`);
  }
  return { metadata, ...result };
}

export function loadVerifiedContractArtifacts() {
  // This script lives at apps/backend/scripts in both source and installed overlay.
  // All paths are constants under the repository; no path comes from user input.
  const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
  return validateContractArtifacts(
    read('../../../packages/shared/contracts/deployments/hedera-testnet.json'),
    read('../../../packages/contracts/ignition/deployments/chain-296/deployed_addresses.json'),
    {
      TestEnergyUSD: read('../../../packages/shared/contracts/abis/TestEnergyUSD.json'),
      EnergyTradingEscrow: read('../../../packages/shared/contracts/abis/EnergyTradingEscrow.json'),
    },
  );
}

export function requirePositiveTradeId(value) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!UINT.test(text) || text === '0' || text.length > 78) throw new Error('Trade ID must be a positive uint256');
  const id = BigInt(text);
  if (id > (1n << 256n) - 1n) throw new Error('Trade ID exceeds uint256');
  return id;
}

export function requireBytes32(value) {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw new Error('Expected bytes32 hex value');
  return value;
}

function asResultNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid EVM enum/decimal output');
  return number;
}

export function serializableTrade(trade, statuses) {
  const read = (key, index) => trade?.[key] ?? trade?.[index];
  if (!trade) throw new Error('Empty on-chain trade');
  const status = asResultNumber(read('status', 10));
  if (status >= EXPECTED_STATUSES.length || statuses[String(status)] !== EXPECTED_STATUSES[status]) {
    throw new Error('Unknown on-chain trade status');
  }
  const externalTradeId = read('externalTradeId', 0);
  if (typeof externalTradeId !== 'string' || !HEX_32.test(externalTradeId)) throw new Error('Invalid trade bytes32');
  const buyer = read('buyer', 1), seller = read('seller', 2);
  if (!isAddress(buyer) || !isAddress(seller) || buyer.toLowerCase() === seller.toLowerCase()) {
    throw new Error('Invalid on-chain trade parties');
  }
  const toText = (key, index) => BigInt(read(key, index)).toString();
  return {
    externalTradeId, buyer, seller,
    quantityWh: toText('quantityWh', 3),
    unitPriceMicrousdPerKwh: toText('unitPriceMicrousdPerKwh', 4),
    totalAmountMicrousd: toText('totalAmountMicrousd', 5),
    deliveryStart: toText('deliveryStart', 6),
    deliveryDeadline: toText('deliveryDeadline', 7),
    deliveredWh: toText('deliveredWh', 8),
    evidenceHash: requireBytes32(read('evidenceHash', 9)),
    statusCode: status, status: statuses[String(status)],
  };
}

function asJsonValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (value && typeof value === 'object') {
    // ParseLog Result has integer positions; we explicitly read declared ABI inputs instead.
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, asJsonValue(val)]));
  }
  return value;
}

export function parseKnownReceiptLogs(receipt, artifacts, interfaces) {
  if (!receipt) throw new Error('Transaction receipt not found; check mirror/RPC indexing before retrying');
  if (receipt.status !== 1) throw new Error('Transaction was not successful');
  const addresses = {
    [artifacts.EnergyTradingEscrow.address.toLowerCase()]: 'EnergyTradingEscrow',
    [artifacts.TestEnergyUSD.address.toLowerCase()]: 'TestEnergyUSD',
  };
  const events = [];
  for (const log of receipt.logs ?? []) {
    const name = addresses[log.address?.toLowerCase()];
    if (!name) continue;
    let parsed;
    try { parsed = interfaces[name].parseLog({ topics: log.topics, data: log.data }); }
    catch { continue; } // Unknown event from a future version; never invent an event.
    if (!parsed) continue;
    const args = {};
    parsed.fragment.inputs.forEach((field, i) => { args[field.name || `arg${i}`] = asJsonValue(parsed.args[i]); });
    events.push({ contract: name, event: parsed.name, signature: parsed.signature, args,
      logIndex: log.index ?? null });
  }
  return events;
}

export function parseB13Args(argv) {
  let live = false, txHash, tradeId;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`Repeated argument: ${arg}`);
    seen.add(arg);
    if (arg === '--live') live = true;
    else if (arg === '--tx-hash') { txHash = argv[++i]; if (!txHash || !HEX_32.test(txHash)) throw new Error('--tx-hash requires 0x + 64 hexadecimal characters'); }
    else if (arg === '--trade-id') { tradeId = argv[++i]; requirePositiveTradeId(tradeId); }
    else throw new Error(`Unknown B13 argument: ${arg}`);
  }
  if ((txHash || tradeId) && !live) throw new Error('--tx-hash and --trade-id require --live');
  return { live, txHash, tradeId };
}

export class HederaContractReader {
  constructor(options, deps = {}) {
    this.rpcUrl = requireTestnetRpcUrl(options?.rpcUrl);
    this.artifacts = loadVerifiedContractArtifacts();
    this.deps = deps;
    this.connection = null;
  }

  async getConnection() {
    if (!this.connection) {
      let provider, contractFactory, interfaceFactory;
      if (this.deps.provider && this.deps.contractFactory && this.deps.interfaceFactory) {
        ({ provider, contractFactory, interfaceFactory } = this.deps);
      } else {
        const { JsonRpcProvider, Contract, Interface, FetchRequest } = await import('ethers');
        const request = new FetchRequest(this.rpcUrl);
        request.timeout = 12_000;
        provider = new JsonRpcProvider(request);
        contractFactory = (address, abi) => new Contract(address, abi, provider);
        interfaceFactory = (abi) => new Interface(abi);
      }
      this.connection = {
        provider,
        token: contractFactory(this.artifacts.TestEnergyUSD.address, this.artifacts.TestEnergyUSD.abi),
        escrow: contractFactory(this.artifacts.EnergyTradingEscrow.address, this.artifacts.EnergyTradingEscrow.abi),
        interfaces: {
          TestEnergyUSD: interfaceFactory(this.artifacts.TestEnergyUSD.abi),
          EnergyTradingEscrow: interfaceFactory(this.artifacts.EnergyTradingEscrow.abi),
        },
      };
    }
    return this.connection;
  }

  async checkNetwork() {
    const { provider } = await this.getConnection();
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== 296n) throw new Error('Refusing non-Hedera-Testnet RPC (expected chain ID 296)');
    return provider;
  }

  async verifyDeployment() {
    const provider = await this.checkNetwork();
    const { escrow, token } = await this.getConnection();
    const [tokenCode, escrowCode] = await Promise.all([
      provider.getCode(this.artifacts.TestEnergyUSD.address),
      provider.getCode(this.artifacts.EnergyTradingEscrow.address),
    ]);
    if (!tokenCode || tokenCode === '0x') throw new Error('TestEnergyUSD contract bytecode not found');
    if (!escrowCode || escrowCode === '0x') throw new Error('EnergyTradingEscrow bytecode not found');
    const [decimals, symbol, paymentToken, paused, nextTradeId] = await Promise.all([
      token.decimals(), token.symbol(), escrow.paymentToken(), escrow.paused(), escrow.nextTradeId(),
    ]);
    if (asResultNumber(decimals) !== 6) throw new Error('Expected TestEnergyUSD to have six decimals');
    if (typeof paymentToken !== 'string' || paymentToken.toLowerCase() !== this.artifacts.TestEnergyUSD.address.toLowerCase()) {
      throw new Error('Escrow paymentToken does not point to canonical TestEnergyUSD');
    }
    if (typeof paused !== 'boolean') throw new Error('Escrow paused() returned a non-boolean');
    const next = BigInt(nextTradeId);
    if (next < 1n) throw new Error('Invalid nextTradeId');
    return {
      network: 'hedera-testnet', chainId: 296,
      tokenAddress: this.artifacts.TestEnergyUSD.address,
      escrowAddress: this.artifacts.EnergyTradingEscrow.address,
      tokenDecimals: 6, tokenSymbol: String(symbol),
      escrowPaused: paused, nextTradeId: next.toString(),
      confirmedBytecode: true, paymentTokenMatches: true,
    };
  }

  async getTrade(tradeId) {
    const id = requirePositiveTradeId(tradeId);
    await this.checkNetwork();
    const { escrow } = await this.getConnection();
    const trade = await escrow.getTrade(id);
    return { onChainTradeId: id.toString(),
      ...serializableTrade(trade, this.artifacts.metadata.tradeStatus) };
  }

  async getOnChainTradeId(externalTradeId) {
    requireBytes32(externalTradeId);
    await this.checkNetwork();
    const { escrow } = await this.getConnection();
    return BigInt(await escrow.getOnChainTradeId(externalTradeId)).toString();
  }

  async hasOperatorRole(address) {
    if (!isAddress(address)) throw new Error('Invalid operator EVM address');
    await this.checkNetwork();
    const { escrow } = await this.getConnection();
    return Boolean(await escrow.hasRole(await escrow.OPERATOR_ROLE(), address));
  }

  async readReceiptEvents(txHash) {
    requireBytes32(txHash);
    const provider = await this.checkNetwork();
    const { interfaces } = await this.getConnection();
    const receipt = await provider.getTransactionReceipt(txHash);
    return { txHash, events: parseKnownReceiptLogs(receipt, this.artifacts, interfaces) };
  }

  close() {
    this.connection?.provider?.destroy?.();
    this.connection = null;
  }
}

export function createHederaContractReader(options, deps) {
  return new HederaContractReader(options, deps);
}
