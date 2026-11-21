import {defineConfig,configVariable} from 'hardhat/config';
import toolbox from '@nomicfoundation/hardhat-toolbox-mocha-ethers';
// This test-only configuration never loads Hedera credentials or networks.
const rpc=new URL(process.env.B25_LOCAL_RPC_URL??'http://127.0.0.1:8545');
if(rpc.protocol!=='http:'||rpc.hostname!=='127.0.0.1')throw Error('B25 test RPC must be loopback');
export default defineConfig({plugins:[toolbox],solidity:{profiles:{default:{version:'0.8.34',settings:{evmVersion:'cancun'}}}},networks:{localB25:{type:'http',chainType:'l1',chainId:31337,url:configVariable('B25_LOCAL_RPC_URL')}}});
