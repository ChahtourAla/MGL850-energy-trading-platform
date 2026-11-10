/** B14 Phase B2. Defaults to read-only; --stage writes only immutable PLANNED journal row. Never signs or broadcasts. */
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import {
  parseBuyerTopupArgs, prepareBuyerTopup, checkStagingPermission, existingTopupDisposition,
} from './b14-buyer-hbar-core.mjs';

async function main() {
  const args = parseBuyerTopupArgs(process.argv.slice(2));
  const shouldStage = checkStagingPermission(args, process.env);
  if (process.env.HEDERA_NETWORK !== 'testnet') throw new Error('HEDERA_NETWORK must be testnet');
  if (!process.env.HEDERA_TESTNET_RPC_URL || !process.env.DATABASE_URL) throw new Error('Hedera RPC and DATABASE_URL must be configured');
  const artifacts = loadVerifiedContractArtifacts();
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import('@prisma/adapter-pg'), import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const reader = createHederaContractReader({ rpcUrl: process.env.HEDERA_TESTNET_RPC_URL });
  try {
    const match = await prisma.match.findUnique({ where: { id: args.matchId } });
    if (!match) throw new Error('No B12 match for supplied match UUID');
    const run = await prisma.matchingRun.findUnique({ where: { timeSlot: match.timeSlot } });
    if (!run) throw new Error('MatchingRun row missing');
    const [rows, energies, buyerWallet, sellerWallet, buyerProfile, localTrade] = await Promise.all([
      prisma.match.findMany({ where: { timeSlot: match.timeSlot } }),
      prisma.energyRecord.findMany({ where: { snapshotId: run.snapshotId } }),
      prisma.wallet.findUnique({ where: { userId: match.buyerId } }),
      prisma.wallet.findUnique({ where: { userId: match.sellerId } }),
      prisma.user.findUnique({ where: { id: match.buyerId }, select: { id: true, preferredEnergyType: true } }),
      prisma.trade.findUnique({ where: { matchId: match.id } }),
    ]);
    const terms = assertStoredMatch({ match, run, rows, energyRecords: energies, buyerWallet, sellerWallet, buyerProfile });
    if (!buyerWallet?.hederaAccountId || !buyerWallet?.evmAddress) throw new Error('Trusted B07 buyer wallet unavailable');
    const externalId = externalTradeId(match.id, artifacts.EnergyTradingEscrow.address);
    const deployment = await reader.verifyDeployment();
    if (deployment.escrowPaused) throw new Error('Escrow is paused; stop');
    const [hasRole, existingOnChainId] = await Promise.all([
      reader.hasOperatorRole(args.operatorAddress), reader.getOnChainTradeId(externalId),
    ]);
    const { provider } = await reader.getConnection();
    const [buyerBalanceWei, operatorBalanceWei] = await Promise.all([
      provider.getBalance(terms.buyer), provider.getBalance(args.operatorAddress),
    ]);
    const plan = prepareBuyerTopup({
      matchId: match.id, buyerAddress: terms.buyer, operatorAddress: args.operatorAddress,
      externalTradeId: externalId, topupWei: args.valueWei,
      buyerBalanceWei: buyerBalanceWei.toString(), operatorBalanceWei: operatorBalanceWei.toString(),
      operatorHasRole: hasRole, networkChainId: deployment.chainId,
      existingLocalTrade: localTrade, existingOnChainId, matchStatus: match.status,
      maxExistingBuyerWei: '50000000000000000', // 0.05 HBAR; requires review before transfer
    });
    const existing = await prisma.b14TransactionIntent.findUnique({
      where: { matchId_operation: { matchId: match.id, operation: 'FUND_BUYER_HBAR' } },
    });
    const disposition = existingTopupDisposition(existing, plan);
    console.log('B14 B2 VERIFIED PLAN: ' + JSON.stringify({
      matchId: match.id, operation: plan.operation, signer: plan.signerAddress,
      buyer: plan.targetAddress, valueWei: plan.valueWei,
      hbar: args.hbar, buyerHbarWei: buyerBalanceWei.toString(),
      operatorHbarWei: operatorBalanceWei.toString(), payloadSha256: plan.payloadSha256,
      journal: disposition, databaseWriteRequested: shouldStage,
    }, null, 2));
    if (!shouldStage) {
      console.log('B14 B2 PREVIEW PASS: no database mutations, signing or blockchain transactions');
      return;
    }
    const result = await prisma.$transaction(async (tx) => {
      // Lock canonical match, serializing staging of same match within PostgreSQL.
      const locked = await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) throw new Error('Match disappeared during transaction');
      const current = await tx.match.findUnique({ where: { id: match.id }, select: { status: true } });
      if (current?.status !== 'SELECTED') throw new Error('Match changed status before staging');
      const row = await tx.b14TransactionIntent.findUnique({
        where: { matchId_operation: { matchId: match.id, operation: 'FUND_BUYER_HBAR' } },
      });
      if (row) {
        existingTopupDisposition(row, plan);
        return { result: 'UNCHANGED', row };
      }
      const staged = await tx.b14TransactionIntent.create({
        data: {
          matchId: match.id, externalTradeId: externalId, operation: 'FUND_BUYER_HBAR',
          chainId: 296, signerAddress: plan.signerAddress, targetAddress: plan.targetAddress,
          payloadSha256: plan.payloadSha256, status: 'PLANNED',
        },
      });
      return { result: 'CREATED', row: staged };
    });
    console.log(`B14 B2 STAGED: ${result.result} intent=${result.row.id} status=${result.row.status} operation=FUND_BUYER_HBAR`);
    console.log('B14 B2 SAFE: this is a PostgreSQL intent only; no transaction signed, broadcast, or funded');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error('B14 B2 FAILED:', error instanceof Error ? error.message : String(error));
  console.error('Stop: do not sign or broadcast any transaction on this failure.');
  process.exitCode = 1;
});
