/**
 * B13 offline-first safe preflight. Never sends a state-changing transaction.
 * Run from apps/backend:
 *   node scripts/b13-contract-preflight.mjs
 *   node --env-file=../../.env scripts/b13-contract-preflight.mjs --live
 */
import { createHederaContractReader, loadVerifiedContractArtifacts, parseB13Args } from './b13-contract-client.mjs';

async function main() {
  const opts = parseB13Args(process.argv.slice(2));
  const files = loadVerifiedContractArtifacts();
  console.log('B13 OFFLINE PASS: deployment chain ID 296, Ignition addresses, both ABIs, event signatures, trade status mapping');
  console.log('B13 DEPLOYMENT: TestEnergyUSD=' + files.TestEnergyUSD.address);
  console.log('B13 DEPLOYMENT: EnergyTradingEscrow=' + files.EnergyTradingEscrow.address);
  if (!opts.live) {
    console.log('B13 OFFLINE ONLY: no RPC connection and no blockchain transactions. Use --live to verify deployed contracts.');
    return;
  }
  if (process.env.HEDERA_NETWORK !== 'testnet') {
    throw new Error('B13 live reads require HEDERA_NETWORK=testnet');
  }
  const client = createHederaContractReader({ rpcUrl: process.env.HEDERA_TESTNET_RPC_URL });
  try {
    const status = await client.verifyDeployment();
    console.log('B13 LIVE PASS: chain=' + status.chainId + '; bytecode confirmed; payment token matched; decimals=' + status.tokenDecimals);
    console.log('B13 STATE: token=' + status.tokenSymbol + '; escrowPaused=' + status.escrowPaused + '; nextTradeId=' + status.nextTradeId);
    if (opts.tradeId) {
      const trade = await client.getTrade(opts.tradeId);
      console.log('B13 TRADE: ' + JSON.stringify(trade));
    }
    if (opts.txHash) {
      const receipt = await client.readReceiptEvents(opts.txHash);
      console.log('B13 RECEIPT EVENTS: ' + JSON.stringify(receipt));
    }
    console.log('B13 PASS: read-only Hedera Testnet smart contract integration; no transactions, fees, DB changes, or wallet-key access');
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error('B13 FAILED:', error?.message || String(error));
  process.exitCode = 1;
});
