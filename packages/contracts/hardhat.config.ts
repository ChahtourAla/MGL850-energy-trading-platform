import 'dotenv/config';
import hardhatToolboxMochaEthersPlugin from '@nomicfoundation/hardhat-toolbox-mocha-ethers';
import { configVariable, defineConfig } from 'hardhat/config';

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: '0.8.34',
        settings: {
          evmVersion: 'cancun',
        },
      },

      production: {
        version: '0.8.34',
        settings: {
          evmVersion: 'cancun',
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: 'edr-simulated',
      chainType: 'l1',
    },
    hardhatOp: {
      type: 'edr-simulated',
      chainType: 'op',
    },
    hederaTestnet: {
      type: 'http',
      chainType: 'l1',
      chainId: 296,
      url: configVariable('HEDERA_TESTNET_RPC_URL'),
      accounts: [
        configVariable('HEDERA_ADMIN_PRIVATE_KEY'),
        configVariable('HEDERA_OPERATOR_PRIVATE_KEY'),
        configVariable('HEDERA_ORACLE_PRIVATE_KEY'),
        configVariable('HEDERA_PAUSER_PRIVATE_KEY'),
      ],
    },
  },
});
