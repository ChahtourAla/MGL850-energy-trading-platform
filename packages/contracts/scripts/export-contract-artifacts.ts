import { mkdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const contractsRoot = path.resolve(__dirname, '..');

const sharedContractsRoot = path.resolve(contractsRoot, '../shared/contracts');

const abiOutputDir = path.join(sharedContractsRoot, 'abis');

const deploymentOutputDir = path.join(sharedContractsRoot, 'deployments');

await mkdir(abiOutputDir, { recursive: true });

await mkdir(deploymentOutputDir, { recursive: true });

// ---------------------------------------------------------
// Read Hardhat artifacts
// ---------------------------------------------------------

const escrowArtifactPath = path.join(
  contractsRoot,
  'artifacts/contracts/EnergyTradingEscrow.sol/EnergyTradingEscrow.json',
);

const tokenArtifactPath = path.join(
  contractsRoot,
  'artifacts/contracts/TestEnergyUSD.sol/TestEnergyUSD.json',
);

const escrowArtifact = JSON.parse(await readFile(escrowArtifactPath, 'utf8'));

const tokenArtifact = JSON.parse(await readFile(tokenArtifactPath, 'utf8'));

// ---------------------------------------------------------
// Export ABI only
// ---------------------------------------------------------

await writeFile(
  path.join(abiOutputDir, 'EnergyTradingEscrow.json'),
  JSON.stringify(escrowArtifact.abi, null, 2) + '\n',
);

await writeFile(
  path.join(abiOutputDir, 'TestEnergyUSD.json'),
  JSON.stringify(tokenArtifact.abi, null, 2) + '\n',
);

// ---------------------------------------------------------
// Read real Hedera deployment addresses
// ---------------------------------------------------------

const ignitionDeploymentPath = path.join(
  contractsRoot,
  'ignition/deployments/chain-296/deployed_addresses.json',
);

const ignitionDeployment = JSON.parse(await readFile(ignitionDeploymentPath, 'utf8'));

const testEnergyUsdAddress = ignitionDeployment['EnergyTradingModule#TestEnergyUSD'];

const energyTradingEscrowAddress = ignitionDeployment['EnergyTradingModule#EnergyTradingEscrow'];

if (!testEnergyUsdAddress || !energyTradingEscrowAddress) {
  throw new Error('Missing Hedera Testnet deployment addresses.');
}

// ---------------------------------------------------------
// Canonical deployment metadata
// ---------------------------------------------------------

const deploymentMetadata = {
  schemaVersion: '1.0.0',

  network: {
    name: 'hedera-testnet',
    chainId: 296,
  },

  contracts: {
    TestEnergyUSD: {
      address: testEnergyUsdAddress,
      abi: '../abis/TestEnergyUSD.json',
    },

    EnergyTradingEscrow: {
      address: energyTradingEscrowAddress,
      abi: '../abis/EnergyTradingEscrow.json',
    },
  },

  tradeStatus: {
    CREATED: 0,
    FUNDED: 1,
    AWAITING_DELIVERY: 2,
    DELIVERED: 3,
    COMPLETED: 4,
    CANCELLED: 5,
    EXPIRED: 6,
    FAILED: 7,
    REFUNDED: 8,
  },

  events: [
    'TradeCreated',
    'TradeFunded',
    'DeliveryConfirmed',
    'TradeSettled',
    'TradeRefunded',
    'TradeCancelled',
    'TradeExpired',
  ],
};

await writeFile(
  path.join(deploymentOutputDir, 'hedera-testnet.json'),
  JSON.stringify(deploymentMetadata, null, 2) + '\n',
);

console.log('Contract artifacts exported successfully.');

console.log('TestEnergyUSD:', testEnergyUsdAddress);

console.log('EnergyTradingEscrow:', energyTradingEscrowAddress);

console.log('Output:', sharedContractsRoot);
