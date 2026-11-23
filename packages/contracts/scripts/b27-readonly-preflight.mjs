import { Contract, JsonRpcProvider, getAddress } from 'ethers';

const rpc = process.env.HEDERA_JSON_RPC_URL;

const tokenAddress = getAddress(process.env.B27_EXPECTED_TEUSD_ADDRESS);

const settlementAddress = getAddress(process.env.B27_EXPECTED_SETTLEMENT_ADDRESS);

const admin = '0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4';
const operator = '0xD74a6786587A2a936cFb059fec998Ad6DB300F37';
const pauser = '0xdbE6307045F555bE2Ac20299D4aabf1a8Abf8C67';

const provider = new JsonRpcProvider(rpc);

async function main() {
  const network = await provider.getNetwork();

  if (network.chainId !== 296n) {
    throw new Error('Wrong network');
  }

  const token = new Contract(
    tokenAddress,
    [
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function MINTER_ROLE() view returns (bytes32)',
      'function hasRole(bytes32,address) view returns (bool)',
    ],
    provider,
  );

  const settlement = new Contract(
    settlementAddress,
    [
      'function paymentToken() view returns (address)',
      'function paused() view returns (bool)',
      'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
      'function OPERATOR_ROLE() view returns (bytes32)',
      'function PAUSER_ROLE() view returns (bytes32)',
      'function hasRole(bytes32,address) view returns (bool)',
    ],
    provider,
  );

  const checks = {
    tokenCode: (await provider.getCode(tokenAddress)) !== '0x',
    settlementCode: (await provider.getCode(settlementAddress)) !== '0x',
    decimals: BigInt(await token.decimals()) === 6n,
    tokenBinding: getAddress(await settlement.paymentToken()) === tokenAddress,
    adminRole: await settlement.hasRole(await settlement.DEFAULT_ADMIN_ROLE(), admin),
    minterRole: await token.hasRole(await token.MINTER_ROLE(), admin),
    operatorRole: await settlement.hasRole(await settlement.OPERATOR_ROLE(), operator),
    pauserRole: await settlement.hasRole(await settlement.PAUSER_ROLE(), pauser),
    notPaused: !(await settlement.paused()),
  };

  console.log('=== HEDERA TESTNET PRE-FLIGHT ===');

  for (const [name, passed] of Object.entries(checks)) {
    console.log(`${name}: ${passed ? 'PASS' : 'FAIL'}`);
  }

  console.log('TEUSD total supply (base units):', (await token.totalSupply()).toString());

  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error('Preflight checks failed');
  }

  console.log('PASS: READ-ONLY CONTRACT PREFLIGHT');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
