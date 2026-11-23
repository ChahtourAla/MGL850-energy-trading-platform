import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.HEDERA_JSON_RPC_URL;
const PRIVATE_KEY = process.env.HEDERA_DEPLOYER_PRIVATE_KEY;
const send = process.argv.includes('--send');

function requiredAddress(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return getAddress(value);
}

function artifact(name) {
  const path = new URL(`../artifacts/contracts/${name}.sol/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  if (!RPC || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY ?? '')) {
    throw new Error('RPC URL or deployer private key is missing/invalid');
  }

  const provider = new JsonRpcProvider(RPC);
  const chainId = BigInt(await provider.send('eth_chainId', []));

  if (chainId !== 296n) {
    throw new Error(`Wrong network: ${chainId}`);
  }

  const deployer = new Wallet(PRIVATE_KEY, provider);
  const admin = deployer.address;
  const operator = requiredAddress('B27_OPERATOR_ADDRESS');
  const pauser = requiredAddress('B27_PAUSER_ADDRESS');

  if (new Set([admin.toLowerCase(), operator.toLowerCase(), pauser.toLowerCase()]).size !== 3) {
    throw new Error('Admin, operator and pauser must be distinct');
  }

  const balance = await provider.getBalance(admin);

  console.log('Network:', 'Hedera Testnet (296)');
  console.log('Deployer/admin:', admin);
  console.log('Operator:', operator);
  console.log('Pauser:', pauser);
  console.log('HBAR balance:', balance.toString(), 'tinybar-equivalent wei units');

  if (balance === 0n) {
    throw new Error('Fund the deployer with Testnet HBAR');
  }

  async function deploy(name, args) {
    const compiled = artifact(name);
    const factory = new ContractFactory(compiled.abi, compiled.bytecode, deployer);

    const request = await factory.getDeployTransaction(...args);
    const estimatedGas = await provider.estimateGas({
      from: admin,
      data: request.data,
      value: 0n,
    });

    console.log(`${name} estimated gas:`, estimatedGas.toString());

    if (!send) {
      console.log(`[PREVIEW] Would deploy ${name}`);
      return null;
    }

    const contract = await factory.deploy(...args, {
      gasLimit: (estimatedGas * 130n) / 100n,
    });

    const tx = contract.deploymentTransaction();
    console.log(`${name} transaction:`, tx.hash);

    await contract.waitForDeployment();

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${name} deployment failed`);
    }

    const address = await contract.getAddress();
    if ((await provider.getCode(address)) === '0x') {
      throw new Error(`${name} has no deployed bytecode`);
    }

    console.log(`${name} deployed:`, address);
    return address;
  }

  const createToken = process.env.B27_DEPLOY_NEW_TEUSD === 'true';
  let tokenAddress;

  if (createToken) {
    if (process.env.B27_EXPECTED_TEUSD_ADDRESS) {
      throw new Error('Choose either an existing TEUSD or a new token');
    }

    tokenAddress = await deploy('TestEnergyUSD', [admin]);

    if (!send) {
      console.log('Settlement deployment preview requires a token address.');
      console.log('Use --send only after reviewing roles and funding.');
      return;
    }
  } else {
    tokenAddress = requiredAddress('B27_EXPECTED_TEUSD_ADDRESS');
  }

  if ((await provider.getCode(tokenAddress)) === '0x') {
    throw new Error('TEUSD address has no deployed contract code');
  }

  const token = new Contract(tokenAddress, ['function decimals() view returns (uint8)'], provider);

  if (BigInt(await token.decimals()) !== 6n) {
    throw new Error('TEUSD must use 6 decimals');
  }

  console.log('TEUSD verified:', tokenAddress);

  const settlementAddress = await deploy('EnergyTradingDirectSettlement', [
    tokenAddress,
    admin,
    operator,
    pauser,
  ]);

  if (!send) {
    console.log('PREVIEW COMPLETE — no transactions submitted');
    return;
  }

  const settlement = new Contract(
    settlementAddress,
    [
      'function paymentToken() view returns (address)',
      'function OPERATOR_ROLE() view returns (bytes32)',
      'function PAUSER_ROLE() view returns (bytes32)',
      'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
      'function hasRole(bytes32,address) view returns (bool)',
    ],
    provider,
  );

  const checks = [
    getAddress(await settlement.paymentToken()) === tokenAddress,
    await settlement.hasRole(await settlement.DEFAULT_ADMIN_ROLE(), admin),
    await settlement.hasRole(await settlement.OPERATOR_ROLE(), operator),
    await settlement.hasRole(await settlement.PAUSER_ROLE(), pauser),
  ];

  if (checks.some((passed) => !passed)) {
    throw new Error('Post-deployment verification failed');
  }

  console.log('\n=== DEPLOYMENT VERIFIED ===');
  console.log(`B27_EXPECTED_TEUSD_ADDRESS=${tokenAddress}`);
  console.log(`B27_EXPECTED_SETTLEMENT_ADDRESS=${settlementAddress}`);
}

main().catch((error) => {
  console.error('Deployment stopped:', error.message);
  process.exitCode = 1;
});
