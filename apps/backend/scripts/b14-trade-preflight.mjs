/** B14 phase A: strictly read-only trade readiness preflight. No signers or writes. */
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import {
  assertExistingChainMatches, assertStoredMatch, chooseMatch,
  externalTradeId, parseB14Args, tradeWindow,
} from './b14-trade-core.mjs';

async function readFromTrustedDatabase(timeSlot, matchId) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import('@prisma/adapter-pg'), import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const hour = new Date(timeSlot);
    const run = await prisma.matchingRun.findUnique({ where: { timeSlot: hour } });
    if (!run) throw new Error('No committed B12 matching run for specified UTC hour');
    const rows = await prisma.match.findMany({ where: { timeSlot: hour }, orderBy: { id: 'asc' } });
    const match = chooseMatch(rows, matchId);
    const [energyRecords, buyerWallet, sellerWallet, buyerProfile, localTrade] = await Promise.all([
      prisma.energyRecord.findMany({ where: { snapshotId: run.snapshotId } }),
      prisma.wallet.findUnique({ where: { userId: match.buyerId } }),
      prisma.wallet.findUnique({ where: { userId: match.sellerId } }),
      prisma.user.findUnique({ where: { id: match.buyerId }, select: { id: true, preferredEnergyType: true } }),
      prisma.trade.findUnique({ where: { matchId: match.id } }),
    ]);
    const terms = assertStoredMatch({ match, run, rows, energyRecords, buyerWallet, sellerWallet, buyerProfile });
    return {
      matchId: match.id, snapshotId: run.snapshotId,
      timeSlot: hour.toISOString(), algorithmVersion: run.algorithmVersion,
      matchStatus: match.status, ...terms,
      localTrade: localTrade && { id: localTrade.id, status: localTrade.status,
        onChainTradeId: localTrade.onChainTradeId?.toString() ?? null },
    };
  } finally { await prisma.$disconnect(); }
}

async function readTokenStatus(rpcUrl, artifacts, buyer) {
  const { JsonRpcProvider, Contract, FetchRequest } = await import('ethers');
  const request = new FetchRequest(rpcUrl); request.timeout = 12_000;
  const provider = new JsonRpcProvider(request);
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== 296n) throw new Error('Token RPC is not Hedera Testnet');
    const token = new Contract(artifacts.TestEnergyUSD.address, artifacts.TestEnergyUSD.abi, provider);
    const [balance, allowance] = await Promise.all([
      token.balanceOf(buyer), token.allowance(buyer, artifacts.EnergyTradingEscrow.address),
    ]);
    return { buyerBalanceMicroUsd: BigInt(balance).toString(), buyerAllowanceMicroUsd: BigInt(allowance).toString() };
  } finally { provider.destroy(); }
}

async function main() {
  const args = parseB14Args(process.argv.slice(2));
  const artifacts = loadVerifiedContractArtifacts();
  console.log('B14 OFFLINE PASS: chain 296, canonical ABI metadata, deterministic trade-planning rules');
  if (args.offline) {
    console.log('B14 OFFLINE ONLY: no database access, no RPC access, no private keys and no transactions');
    return;
  }
  if (process.env.HEDERA_NETWORK !== 'testnet') throw new Error('HEDERA_NETWORK must be testnet');
  if (!process.env.HEDERA_TESTNET_RPC_URL) throw new Error('HEDERA_TESTNET_RPC_URL is required');
  const plan = await readFromTrustedDatabase(args.timeSlot, args.matchId);
  const window = tradeWindow(args.deliveryStart);
  const intentId = externalTradeId(plan.matchId, artifacts.EnergyTradingEscrow.address);
  const client = createHederaContractReader({ rpcUrl: process.env.HEDERA_TESTNET_RPC_URL });
  try {
    const status = await client.verifyDeployment();
    const existingOnChainId = await client.getOnChainTradeId(intentId);
    let existingOnChain = null;
    if (existingOnChainId !== '0') {
      existingOnChain = await client.getTrade(existingOnChainId);
      assertExistingChainMatches(existingOnChain, plan, intentId);
    }
    const publicBalances = await readTokenStatus(process.env.HEDERA_TESTNET_RPC_URL, artifacts, plan.buyer);
    const canFund = BigInt(publicBalances.buyerBalanceMicroUsd) >= BigInt(plan.totalAmountMicrousd) &&
      BigInt(publicBalances.buyerAllowanceMicroUsd) >= BigInt(plan.totalAmountMicrousd);
    const operatorHasRole = args.operatorAddress ? await client.hasOperatorRole(args.operatorAddress) : null;
    const output = {
      chainId: 296, escrowAddress: status.escrowAddress, tokenAddress: status.tokenAddress,
      matchId: plan.matchId, snapshotId: plan.snapshotId, timeSlot: plan.timeSlot,
      matchStatus: plan.matchStatus, externalTradeId: intentId,
      buyer: plan.buyer, seller: plan.seller,
      quantityWh: plan.quantityWh, unitPriceMicrousdPerKwh: plan.unitPriceMicrousdPerKwh,
      totalAmountMicrousd: plan.totalAmountMicrousd,
      deliveryWindow: window,
      existingLocalTrade: plan.localTrade,
      existingOnChainId, existingOnChainStatus: existingOnChain?.status ?? null,
      buyerBalanceMicroUsd: publicBalances.buyerBalanceMicroUsd,
      buyerAllowanceMicroUsd: publicBalances.buyerAllowanceMicroUsd,
      canFund, operatorAddress: args.operatorAddress ?? null,
      operatorHasRole, escrowPaused: status.escrowPaused,
    };
    console.log('B14 PLAN: ' + JSON.stringify(output, null, 2));
    if (plan.localTrade) console.log('B14 NOTICE: an existing PostgreSQL trade is already linked to this match. Never create a replacement.');
    if (existingOnChain) console.log('B14 NOTICE: on-chain externalTradeId already used. Reconcile; never submit createTrade again.');
    if (!canFund) console.log('B14 NEEDS FUNDING SETUP: buyer TEUSD balance/allowance are not both sufficient; do not call fundTrade yet.');
    if (operatorHasRole === false) console.log('B14 NEEDS OPERATOR ROLE: supplied operator address lacks OPERATOR_ROLE.');
    if (status.escrowPaused) console.log('B14 NEEDS UNPAUSE: escrow contract is paused.');
    console.log('B14 READ-ONLY PASS: committed B12 match + trusted wallets + Solidity amount + Hedera state checked.');
    console.log('B14 SAFETY: no signatures, contract writes, database changes or HBAR fees.');
  } finally { client.close(); }
}

main().catch(error => {
  console.error('B14 PREFLIGHT FAILED:', error instanceof Error ? error.message : String(error));
  console.error('Stop; do not mint, approve, create or fund a trade until this is resolved.');
  process.exitCode = 1;
});
