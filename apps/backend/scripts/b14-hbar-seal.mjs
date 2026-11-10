/**
 * B14 Phase B3: operator HBAR transfer preview / encrypted pre-broadcast seal.
 * NO sendTransaction / broadcastTransaction / fundTrade / DB migration.
 * --seal persists the *already signed but unbroadcast* bytes encrypted in the B14 journal.
 * The later B4 recovery executor will be the only code allowed to broadcast.
 */
import { Wallet, Transaction } from 'ethers';
import { externalTradeId, assertStoredMatch } from './b14-trade-core.mjs';
import { loadVerifiedContractArtifacts, createHederaContractReader } from './b13-contract-client.mjs';
import { prepareBuyerTopup } from './b14-buyer-hbar-core.mjs';
import { encryptSignedTransaction, checkTransition } from './b14-intent-journal-core.mjs';
import {
  parseHbarSealArgs, requireSealPermission, verifyStagedIntent, requireCleanSignerQueue,
  requireNonce, computeSafeGasQuote, makeUnsignedTopup, verifySignedEnvelope,
} from './b14-hbar-seal-core.mjs';

async function main() {
  const args = parseHbarSealArgs(process.argv.slice(2));
  const sealing = requireSealPermission(args, process.env);
  if (process.env.HEDERA_NETWORK !== 'testnet') throw new Error('HEDERA_NETWORK must be testnet');
  if (!process.env.HEDERA_TESTNET_RPC_URL || !process.env.DATABASE_URL) throw new Error('RPC and DATABASE_URL are required');
  if (!process.env.HEDERA_OPERATOR_PRIVATE_KEY) throw new Error('HEDERA_OPERATOR_PRIVATE_KEY missing (load local contracts .env)');
  if (sealing && !process.env.B14_SIGNED_TX_KEY_B64) throw new Error('B14_SIGNED_TX_KEY_B64 missing; signed transaction must be encrypted');

  const operator = new Wallet(process.env.HEDERA_OPERATOR_PRIVATE_KEY);
  if (operator.address.toLowerCase() !== args.operatorAddress) throw new Error('Operator private key address does not match the selected public operator address');

  const artifacts = loadVerifiedContractArtifacts();
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import('@prisma/adapter-pg'), import('../dist/generated/prisma/client.js'),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const reader = createHederaContractReader({ rpcUrl: process.env.HEDERA_TESTNET_RPC_URL });

  try {
    const match = await prisma.match.findUnique({ where: { id: args.matchId } });
    if (!match) throw new Error('Selected B12 match missing');
    const run = await prisma.matchingRun.findUnique({ where: { timeSlot: match.timeSlot } });
    if (!run) throw new Error('B12 matching run missing');
    const [rows, energies, buyerWallet, sellerWallet, buyerProfile, localTrade, journal] = await Promise.all([
      prisma.match.findMany({ where: { timeSlot: match.timeSlot } }),
      prisma.energyRecord.findMany({ where: { snapshotId: run.snapshotId } }),
      prisma.wallet.findUnique({ where: { userId: match.buyerId } }),
      prisma.wallet.findUnique({ where: { userId: match.sellerId } }),
      prisma.user.findUnique({ where: { id: match.buyerId }, select: { id: true, preferredEnergyType: true } }),
      prisma.trade.findUnique({ where: { matchId: args.matchId } }),
      prisma.b14TransactionIntent.findUnique({ where: { id: args.intentId } }),
    ]);
    const terms = assertStoredMatch({ match, run, rows, energyRecords: energies, buyerWallet, sellerWallet, buyerProfile });
    if (!buyerWallet?.hederaAccountId) throw new Error('B07 buyer Hedera account not onboarded');
    const extId = externalTradeId(match.id, artifacts.EnergyTradingEscrow.address);
    const deploy = await reader.verifyDeployment();
    if (deploy.chainId !== 296 || deploy.escrowPaused) throw new Error('Wrong chain or escrow paused');
    const [role, existingOnChainId] = await Promise.all([
      reader.hasOperatorRole(args.operatorAddress), reader.getOnChainTradeId(extId),
    ]);
    const { provider } = await reader.getConnection();
    const [buyerBalanceWei, operatorBalanceWei] = await Promise.all([
      provider.getBalance(terms.buyer), provider.getBalance(args.operatorAddress),
    ]);
    const plan = prepareBuyerTopup({
      matchId: match.id, buyerAddress: terms.buyer, operatorAddress: args.operatorAddress,
      externalTradeId: extId, topupWei: args.valueWei,
      buyerBalanceWei: buyerBalanceWei.toString(), operatorBalanceWei: operatorBalanceWei.toString(),
      operatorHasRole: role, networkChainId: deploy.chainId,
      existingLocalTrade: localTrade, existingOnChainId, matchStatus: match.status,
      maxExistingBuyerWei: '50000000000000000',
    });
    verifyStagedIntent(journal, plan, args.intentId);
    const signerQueue = await prisma.b14TransactionIntent.findMany({
      where: { signerAddress: args.operatorAddress, status: { in: ['SIGNED', 'SUBMITTED', 'NEEDS_RECONCILIATION'] } },
      select: { id: true, status: true },
    });
    requireCleanSignerQueue(signerQueue, args.intentId);

    async function readLiveQuote() {
      const [latest, pending, gasEst, gasPrice, balance] = await Promise.all([
        provider.getTransactionCount(args.operatorAddress, 'latest'),
        provider.getTransactionCount(args.operatorAddress, 'pending'),
        provider.estimateGas({ from: args.operatorAddress, to: terms.buyer, value: BigInt(plan.valueWei), data: '0x' }),
        provider.getFeeData(), provider.getBalance(args.operatorAddress),
      ]);
      const nonce = requireNonce(latest, pending);
      if (!gasPrice.gasPrice) throw new Error('RPC did not supply gasPrice for legacy Hedera transfer');
      const fees = computeSafeGasQuote({ estimateGas: gasEst, gasPriceWei: gasPrice.gasPrice,
        senderBalanceWei: balance, valueWei: plan.valueWei });
      const unsigned = makeUnsignedTopup({ chainId: 296, signerAddress: args.operatorAddress,
        targetAddress: plan.targetAddress, valueWei: plan.valueWei, nonce,
        gasLimit: fees.gasLimit, gasPriceWei: fees.gasPriceWei });
      return { fees, unsigned };
    }

    const quote = await readLiveQuote();
    console.log('B14 B3 PREVIEW: ' + JSON.stringify({
      chainId: 296, intentId: journal.id, matchId: match.id, operation: journal.operation,
      status: journal.status, signer: args.operatorAddress, buyer: plan.targetAddress,
      amountHbar: args.hbar, payloadSha256: plan.payloadSha256,
      nonce: String(quote.unsigned.nonce), estimatedGasLimit: quote.unsigned.gasLimit.toString(),
      rpcGasPriceWei: quote.unsigned.gasPrice.toString(), maxGasFeeWei: quote.fees.maxFeeWei.toString(),
      action: sealing ? 'SEAL_ENCRYPTED_SIGNED_TX_ONLY' : 'PREVIEW_ONLY',
    }, null, 2));
    if (!sealing) {
      console.log('B14 B3 PREVIEW PASS: no signing, DB mutations, broadcast or HBAR transfers');
      return;
    }

    // A PostgreSQL transaction-level advisory lock serializes B14 signing per signer.
    // This does NOT coordinate with external wallets using the same key; the pending/latest guard remains mandatory.
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS acquired FROM pg_advisory_xact_lock(296, hashtext(${args.operatorAddress}))`;
      const lock = await tx.$queryRaw`SELECT "id" FROM "b14_transaction_intents" WHERE "id" = ${args.intentId}::uuid FOR UPDATE`;
      if (!Array.isArray(lock) || lock.length !== 1) throw new Error('B14 journal row disappeared before signing');
      const fresh = await tx.b14TransactionIntent.findUnique({ where: { id: args.intentId } });
      verifyStagedIntent(fresh, plan, args.intentId);
      const freshMatch = await tx.match.findUnique({ where: { id: match.id }, select: { status: true } });
      if (freshMatch?.status !== 'SELECTED') throw new Error('B12 match no longer SELECTED');
      const others = await tx.b14TransactionIntent.findMany({
        where: { signerAddress: args.operatorAddress, status: { in: ['SIGNED','SUBMITTED','NEEDS_RECONCILIATION'] } },
        select: { id: true, status: true },
      });
      requireCleanSignerQueue(others, args.intentId);
      const [newBuyerBalance, chainTrade, stillOperator, currentDeploy] = await Promise.all([
        provider.getBalance(terms.buyer), reader.getOnChainTradeId(extId),
        reader.hasOperatorRole(args.operatorAddress), reader.verifyDeployment(),
      ]);
      if (newBuyerBalance >= 50_000_000_000_000_000n || chainTrade !== '0' || !stillOperator || currentDeploy.escrowPaused) {
        throw new Error('Funding or escrow readiness changed since preview; stop');
      }
      const freshQuote = await readLiveQuote();
      // Any different nonce after preview means another signer may have acted; never seal stale assumptions.
      if (freshQuote.unsigned.nonce !== quote.unsigned.nonce) throw new Error('Signer nonce changed after preview; stop');
      const raw = await operator.signTransaction(freshQuote.unsigned); // LOCAL ONLY; NO BROADCAST
      const txDecoded = Transaction.from(raw);
      const hash = verifySignedEnvelope(txDecoded, freshQuote.unsigned, args.operatorAddress);
      const encrypted = encryptSignedTransaction(raw, process.env.B14_SIGNED_TX_KEY_B64, fresh.id);
      checkTransition('PLANNED', 'SIGNED');
      return tx.b14TransactionIntent.update({
        where: { id: fresh.id }, data: {
          status: 'SIGNED', nonce: String(freshQuote.unsigned.nonce), txHash: hash,
          signedTxCiphertext: encrypted.ciphertext,
          signedTxIv: encrypted.iv, signedTxTag: encrypted.tag,
        }, select: { id: true, status: true, operation: true, txHash: true, nonce: true },
      });
    }, { timeout: 45_000, maxWait: 10_000 });
    console.log(`B14 B3 SEALED: intent=${saved.id} status=${saved.status} nonce=${saved.nonce} txHash=${saved.txHash}`);
    console.log('B14 B3 SAFE: encrypted signed bytes persisted; NO broadcast, HBAR transfer or contract write');
  } finally {
    reader.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('B14 B3 FAILED:', error instanceof Error ? error.message : String(error));
  console.error('Stop and inspect journal status. Never delete an intent or sign a replacement to bypass a conflict.');
  process.exitCode = 1;
});
