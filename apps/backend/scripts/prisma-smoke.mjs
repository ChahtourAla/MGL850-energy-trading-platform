import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../dist/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const adapter = new PrismaPg({
  connectionString,
});

const prisma = new PrismaClient({
  adapter,
});

const buyerId = randomUUID();
const sellerId = randomUUID();
const matchId = randomUUID();
const tradeId = randomUUID();

const timeSlot = new Date('2026-11-02T14:00:00.000Z');

const deliveryDeadline = new Date(timeSlot.getTime() + 60 * 60 * 1000);

const externalTradeId = `0x${tradeId.replaceAll('-', '').padStart(64, '0')}`;

const sellerEvmAddress = `0x${sellerId.replaceAll('-', '').padStart(40, '0')}`;

const sellerAccountId = `0.0.${BigInt(
  `0x${sellerId.replaceAll('-', '').slice(0, 12)}`,
).toString()}`;

try {
  // ---------------------------------------------------
  // 1. Create two synthetic users.
  // ---------------------------------------------------

  await prisma.user.createMany({
    data: [
      {
        id: buyerId,
        name: 'B04 Test Buyer',
        email: `buyer-${buyerId}@example.invalid`,
        passwordHash: 'UNUSABLE_TEST_HASH',
        physicalAddress: 'Test Address',
        xKm: '10',
        yKm: '10',
        preferredEnergyType: 'SOLAR',
        reputation: 80,
      },
      {
        id: sellerId,
        name: 'B04 Test Seller',
        email: `seller-${sellerId}@example.invalid`,
        passwordHash: 'UNUSABLE_TEST_HASH',
        physicalAddress: 'Test Address',
        xKm: '12',
        yKm: '11',
        preferredEnergyType: 'ANY',
        reputation: 90,
      },
    ],
  });

  // ---------------------------------------------------
  // 2. Create a synthetic wallet.
  // These are deliberately not real cryptographic keys.
  // ---------------------------------------------------

  await prisma.wallet.create({
    data: {
      userId: sellerId,
      hederaAccountId: sellerAccountId,
      evmAddress: sellerEvmAddress,
      publicKey: 'TEST_ONLY_PUBLIC_KEY',
      encryptedPrivateKey: 'TEST_ONLY_CIPHERTEXT',
      encryptionIv: 'TEST_ONLY_IV',
      encryptionAuthTag: 'TEST_ONLY_AUTH_TAG',
      keyVersion: 1,
    },
  });

  // ---------------------------------------------------
  // 3. Create hourly energy records.
  // ---------------------------------------------------

  await prisma.energyRecord.createMany({
    data: [
      {
        userId: sellerId,
        timeSlot,
        productionWh: 5000n,
        consumptionWh: 1000n,
        netEnergyWh: 4000n,
        marketRole: 'SELLER',
        availableEnergyWh: 4000n,
        requiredEnergyWh: 0n,
        energyType: 'SOLAR',
        askPriceMicrousdPerKwh: 140000n,
      },
      {
        userId: buyerId,
        timeSlot,
        productionWh: 0n,
        consumptionWh: 4000n,
        netEnergyWh: -4000n,
        marketRole: 'BUYER',
        availableEnergyWh: 0n,
        requiredEnergyWh: 4000n,
        maxPriceMicrousdPerKwh: 150000n,
      },
    ],
  });

  // ---------------------------------------------------
  // 4. Create one buyer-seller match.
  // ---------------------------------------------------

  await prisma.match.create({
    data: {
      id: matchId,
      timeSlot,
      buyerId,
      sellerId,
      quantityWh: 4000n,
      unitPriceMicrousdPerKwh: 140000n,
      totalAmountMicrousd: 560000n,
      distanceKm: '2.692582403567',
      score: '0.673626616381',
      sellerEnergyType: 'SOLAR',
      algorithmVersion: '1.0.0',
      status: 'SELECTED',
    },
  });

  // ---------------------------------------------------
  // 5. Create one local trade.
  // ---------------------------------------------------

  await prisma.trade.create({
    data: {
      id: tradeId,
      matchId,
      externalTradeId,
      buyerId,
      sellerId,
      quantityWh: 4000n,
      unitPriceMicrousdPerKwh: 140000n,
      totalAmountMicrousd: 560000n,
      deliveryStart: timeSlot,
      deliveryDeadline,
      status: 'CREATED',
    },
  });

  // ---------------------------------------------------
  // 6. Create a pending delivery record.
  // ---------------------------------------------------

  await prisma.deliveryRecord.create({
    data: {
      tradeId,
      expectedWh: 4000n,
      deliveredWh: 0n,
      timeSlot,
      status: 'PENDING',
    },
  });

  // ---------------------------------------------------
  // 7. Create a local blockchain-operation record.
  // ---------------------------------------------------

  await prisma.blockchainTransaction.create({
    data: {
      tradeId,
      operation: 'CREATE_TRADE',
      status: 'PENDING',
    },
  });

  // ---------------------------------------------------
  // 8. Read persisted data back from PostgreSQL.
  // ---------------------------------------------------

  const savedTrade = await prisma.trade.findUniqueOrThrow({
    where: {
      id: tradeId,
    },
    include: {
      match: true,
      buyer: true,
      seller: true,
      deliveryRecords: true,
      blockchainTransactions: true,
    },
  });

  const savedWallet = await prisma.wallet.findUnique({
    where: {
      userId: sellerId,
    },
  });

  const energyCount = await prisma.energyRecord.count({
    where: {
      userId: {
        in: [buyerId, sellerId],
      },
    },
  });

  assert.equal(savedTrade.matchId, matchId);
  assert.equal(savedTrade.quantityWh, 4000n);
  assert.equal(savedTrade.totalAmountMicrousd, 560000n);
  assert.equal(savedTrade.match.status, 'SELECTED');
  assert.equal(savedTrade.buyer.id, buyerId);
  assert.equal(savedTrade.seller.id, sellerId);
  assert.equal(savedTrade.deliveryRecords.length, 1);
  assert.equal(savedTrade.blockchainTransactions.length, 1);
  assert.equal(savedWallet?.userId, sellerId);
  assert.equal(energyCount, 2);

  console.log('B04 PASS: all seven tables support create/read operations.');
  console.log('B04 PASS: foreign-key relationships work.');
  console.log('B04 PASS: BigInt energy/payment values are preserved.');
} finally {
  // Remove only records created by this script,
  // in foreign-key dependency order.
  try {
    await prisma.$transaction([
      prisma.blockchainTransaction.deleteMany({
        where: { tradeId },
      }),
      prisma.deliveryRecord.deleteMany({
        where: { tradeId },
      }),
      prisma.trade.deleteMany({
        where: { id: tradeId },
      }),
      prisma.match.deleteMany({
        where: { id: matchId },
      }),
      prisma.energyRecord.deleteMany({
        where: {
          userId: {
            in: [buyerId, sellerId],
          },
        },
      }),
      prisma.wallet.deleteMany({
        where: { userId: sellerId },
      }),
      prisma.user.deleteMany({
        where: {
          id: {
            in: [buyerId, sellerId],
          },
        },
      }),
    ]);

    console.log('B04 PASS: synthetic test records cleaned up.');
  } finally {
    await prisma.$disconnect();
  }
}
