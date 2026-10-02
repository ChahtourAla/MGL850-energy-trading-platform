import { readFile } from 'node:fs/promises';
import { network } from 'hardhat';

const { ethers } = await network.create();

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

const sleep = async (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForNonce(address: string, expectedNonce: number, timeoutMs = 60_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const nonce = await ethers.provider.getTransactionCount(address, 'latest');

    if (nonce >= expectedNonce) {
      return;
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for nonce ${expectedNonce} for ${address}`);
}

// ---------------------------------------------------------
// Load deployed addresses
// ---------------------------------------------------------

const deploymentFile = new URL(
  '../ignition/deployments/chain-296/deployed_addresses.json',
  import.meta.url,
);

const deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));

const tokenAddress = deployment['EnergyTradingModule#TestEnergyUSD'];

const escrowAddress = deployment['EnergyTradingModule#EnergyTradingEscrow'];

if (!tokenAddress || !escrowAddress) {
  throw new Error('Missing Hedera deployment addresses.');
}

// ---------------------------------------------------------
// Load configured Hedera signers
// ---------------------------------------------------------

const [admin, operator, oracle, pauser] = await ethers.getSigners();

const adminAddress = await admin.getAddress();

const operatorAddress = await operator.getAddress();

const oracleAddress = await oracle.getAddress();

const pauserAddress = await pauser.getAddress();

// For this smoke test:
//
// operator = buyer
// pauser   = seller
//
// Production/backend integration will use
// dedicated user custodial wallets.
const buyer = operator;

const seller = pauser;

const buyerAddress = operatorAddress;

const sellerAddress = pauserAddress;

// ---------------------------------------------------------
// Connect to deployed contracts
// ---------------------------------------------------------

const token = await ethers.getContractAt('TestEnergyUSD', tokenAddress);

const escrow = await ethers.getContractAt('EnergyTradingEscrow', escrowAddress);

// ---------------------------------------------------------
// Display test configuration
// ---------------------------------------------------------

console.log('\n=== Hedera Testnet Trade Smoke Test ===\n');

console.log('Token:', tokenAddress);

console.log('Escrow:', escrowAddress);

console.log('ADMIN:', adminAddress);

console.log('OPERATOR / BUYER:', buyerAddress);

console.log('ORACLE:', oracleAddress);

console.log('PAUSER / SELLER:', sellerAddress);

// ---------------------------------------------------------
// Define trade
// ---------------------------------------------------------

const quantityWh = 5000n;

const unitPriceMicrousdPerKwh = 140000n;

const requiredAmount = (quantityWh * unitPriceMicrousdPerKwh) / 1000n;

// 5000 Wh × 140000 microUSD/kWh / 1000
// = 700000 microUSD
// = 0.7 TEUSD
console.log('\nTrade quantity:', quantityWh.toString(), 'Wh');

console.log('Unit price:', unitPriceMicrousdPerKwh.toString(), 'microUSD/kWh');

console.log('Required payment:', requiredAmount.toString(), 'microUSD');

console.log('Required payment:', ethers.formatUnits(requiredAmount, 6), 'TEUSD');

// ---------------------------------------------------------
// Create unique externalTradeId
// ---------------------------------------------------------

const nextTradeId = await escrow.nextTradeId();

const externalTradeId = ethers.id(`hedera-testnet-smoke-${nextTradeId.toString()}`);

const latestBlock = await ethers.provider.getBlock('latest');

if (!latestBlock) {
  throw new Error('Unable to read latest Hedera block.');
}

const deliveryStart = BigInt(latestBlock.timestamp + 60);

const deliveryDeadline = deliveryStart + 3600n;

console.log('\nExpected on-chain trade ID:', nextTradeId.toString());

console.log('External trade ID:', externalTradeId);

// ---------------------------------------------------------
// Record initial balances
// ---------------------------------------------------------

const buyerBalanceBefore = await token.balanceOf(buyerAddress);

const sellerBalanceBefore = await token.balanceOf(sellerAddress);

const escrowBalanceBefore = await token.balanceOf(escrowAddress);

console.log('\nInitial buyer TEUSD:', ethers.formatUnits(buyerBalanceBefore, 6));

console.log('Initial seller TEUSD:', ethers.formatUnits(sellerBalanceBefore, 6));

console.log('Initial escrow TEUSD:', ethers.formatUnits(escrowBalanceBefore, 6));

// ---------------------------------------------------------
// STEP 1 — Admin mints TEUSD to buyer
// ---------------------------------------------------------

console.log('\n[1/5] Minting TEUSD to buyer...');

const adminNonceBefore = await ethers.provider.getTransactionCount(adminAddress, 'latest');

const mintTx = await token.connect(admin).mint(buyerAddress, requiredAmount);

console.log('Mint tx:', mintTx.hash);

await mintTx.wait();

await waitForNonce(adminAddress, adminNonceBefore + 1);

console.log('Mint confirmed.');

// ---------------------------------------------------------
// STEP 2 — Buyer approves escrow
// ---------------------------------------------------------

console.log('\n[2/5] Buyer approving escrow...');

const buyerNonceBeforeApprove = await ethers.provider.getTransactionCount(buyerAddress, 'latest');

const approveTx = await token.connect(buyer).approve(escrowAddress, requiredAmount);

console.log('Approve tx:', approveTx.hash);

await approveTx.wait();

await waitForNonce(buyerAddress, buyerNonceBeforeApprove + 1);

console.log('Approval confirmed.');

// ---------------------------------------------------------
// STEP 3 — Operator creates trade
// ---------------------------------------------------------

console.log('\n[3/5] Creating trade...');

const operatorNonceBeforeCreate = await ethers.provider.getTransactionCount(
  operatorAddress,
  'latest',
);

const createTx = await escrow
  .connect(operator)
  .createTrade(
    externalTradeId,
    buyerAddress,
    sellerAddress,
    quantityWh,
    unitPriceMicrousdPerKwh,
    deliveryStart,
    deliveryDeadline,
  );

console.log('Create tx:', createTx.hash);

await createTx.wait();

await waitForNonce(operatorAddress, operatorNonceBeforeCreate + 1);

console.log('Trade creation confirmed.');

// ---------------------------------------------------------
// Verify CREATED state
// ---------------------------------------------------------

let trade = await escrow.getTrade(nextTradeId);

console.log('Trade status after creation:', trade.status.toString());

if (trade.status !== 0n) {
  throw new Error('Expected CREATED status (0).');
}

// ---------------------------------------------------------
// STEP 4 — Operator funds trade
// ---------------------------------------------------------

console.log('\n[4/5] Funding trade...');

const operatorNonceBeforeFund = await ethers.provider.getTransactionCount(
  operatorAddress,
  'latest',
);

const fundTx = await escrow.connect(operator).fundTrade(nextTradeId);

console.log('Fund tx:', fundTx.hash);

await fundTx.wait();

await waitForNonce(operatorAddress, operatorNonceBeforeFund + 1);

console.log('Funding confirmed.');

trade = await escrow.getTrade(nextTradeId);

console.log('Trade status after funding:', trade.status.toString());

if (trade.status !== 2n) {
  throw new Error('Expected AWAITING_DELIVERY status (2).');
}

const escrowBalanceFunded = await token.balanceOf(escrowAddress);

console.log('Escrow TEUSD after funding:', ethers.formatUnits(escrowBalanceFunded, 6));

// ---------------------------------------------------------
// STEP 5 — Oracle confirms delivery
// ---------------------------------------------------------

console.log('\n[5/5] Oracle confirming delivery...');

const evidenceHash = ethers.id(`delivery-evidence-${nextTradeId.toString()}`);

const confirmTx = await escrow
  .connect(oracle)
  .confirmDelivery(nextTradeId, quantityWh, evidenceHash);

console.log('Delivery tx:', confirmTx.hash);

await confirmTx.wait();

console.log('Delivery confirmation confirmed.');

// ---------------------------------------------------------
// Verify final state
// ---------------------------------------------------------

trade = await escrow.getTrade(nextTradeId);

const buyerBalanceAfter = await token.balanceOf(buyerAddress);

const sellerBalanceAfter = await token.balanceOf(sellerAddress);

const escrowBalanceAfter = await token.balanceOf(escrowAddress);

console.log('\n=== Final Verification ===');

console.log('Trade ID:', nextTradeId.toString());

console.log('Final status:', trade.status.toString());

console.log('Delivered Wh:', trade.deliveredWh.toString());

console.log('Evidence hash:', trade.evidenceHash);

console.log('Buyer TEUSD:', ethers.formatUnits(buyerBalanceAfter, 6));

console.log('Seller TEUSD:', ethers.formatUnits(sellerBalanceAfter, 6));

console.log('Escrow TEUSD:', ethers.formatUnits(escrowBalanceAfter, 6));

// ---------------------------------------------------------
// Assertions
// ---------------------------------------------------------

if (trade.status !== 4n) {
  throw new Error('Trade did not reach COMPLETED status.');
}

if (trade.deliveredWh !== quantityWh) {
  throw new Error('Delivered energy does not match expected quantity.');
}

if (sellerBalanceAfter - sellerBalanceBefore !== requiredAmount) {
  throw new Error('Seller did not receive the correct TEUSD amount.');
}

if (escrowBalanceAfter !== escrowBalanceBefore) {
  throw new Error('Escrow retained unexpected TEUSD.');
}

console.log('\n✅ Hedera Testnet trade completed successfully.');
