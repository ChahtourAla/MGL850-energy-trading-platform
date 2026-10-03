import { network } from 'hardhat';

const { ethers } = await network.create();

const networkInfo = await ethers.provider.getNetwork();

const blockNumber = await ethers.provider.getBlockNumber();

const signers = await ethers.getSigners();

console.log('Connected chain ID:', networkInfo.chainId.toString());

console.log('Latest block:', blockNumber);

console.log('Configured signers:', signers.length);

const labels = ['ADMIN', 'OPERATOR', 'ORACLE', 'PAUSER'];

for (let i = 0; i < Math.min(signers.length, labels.length); i++) {
  const signer = signers[i];

  const address = await signer.getAddress();

  const balance = await ethers.provider.getBalance(address);

  console.log(`${labels[i]}:`, address, `balance=${ethers.formatEther(balance)} HBAR`);
}
