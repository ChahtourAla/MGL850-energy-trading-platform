import { readFile } from 'node:fs/promises';
import { network } from 'hardhat';

const { ethers } = await network.create();

const deploymentFile = new URL(
  '../ignition/deployments/chain-296/deployed_addresses.json',
  import.meta.url,
);

const deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));

const tokenAddress = deployment['EnergyTradingModule#TestEnergyUSD'];

const escrowAddress = deployment['EnergyTradingModule#EnergyTradingEscrow'];

if (!tokenAddress || !escrowAddress) {
  throw new Error('Deployment addresses were not found.');
}

const [admin, operator, oracle, pauser] = await ethers.getSigners();

const token = await ethers.getContractAt('TestEnergyUSD', tokenAddress);

const escrow = await ethers.getContractAt('EnergyTradingEscrow', escrowAddress);

const networkInfo = await ethers.provider.getNetwork();

console.log('Chain ID:', networkInfo.chainId.toString());

console.log('TestEnergyUSD:', tokenAddress);

console.log('EnergyTradingEscrow:', escrowAddress);

// ---------------------------------------------------------
// Check bytecode
// ---------------------------------------------------------

const tokenCode = await ethers.provider.getCode(tokenAddress);

const escrowCode = await ethers.provider.getCode(escrowAddress);

console.log('TEUSD bytecode deployed:', tokenCode !== '0x');

console.log('Escrow bytecode deployed:', escrowCode !== '0x');

// ---------------------------------------------------------
// Check TestEnergyUSD
// ---------------------------------------------------------

console.log('TEUSD decimals:', (await token.decimals()).toString());

const tokenAdminRole = await token.DEFAULT_ADMIN_ROLE();

const minterRole = await token.MINTER_ROLE();

console.log('Token admin correct:', await token.hasRole(tokenAdminRole, admin.address));

console.log('Token minter correct:', await token.hasRole(minterRole, admin.address));

// ---------------------------------------------------------
// Check escrow payment-token reference
// ---------------------------------------------------------

const configuredPaymentToken = await escrow.paymentToken();

console.log('Escrow payment token:', configuredPaymentToken);

console.log(
  'Payment token correct:',
  configuredPaymentToken.toLowerCase() === tokenAddress.toLowerCase(),
);

// ---------------------------------------------------------
// Check EnergyTradingEscrow roles
// ---------------------------------------------------------

console.log(
  'Escrow admin correct:',
  await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), admin.address),
);

console.log(
  'Operator role correct:',
  await escrow.hasRole(await escrow.OPERATOR_ROLE(), operator.address),
);

console.log(
  'Oracle role correct:',
  await escrow.hasRole(await escrow.ORACLE_ROLE(), oracle.address),
);

console.log(
  'Pauser role correct:',
  await escrow.hasRole(await escrow.PAUSER_ROLE(), pauser.address),
);

// ---------------------------------------------------------
// Check initial escrow state
// ---------------------------------------------------------

console.log('Next trade ID:', (await escrow.nextTradeId()).toString());

console.log('Paused:', await escrow.paused());
