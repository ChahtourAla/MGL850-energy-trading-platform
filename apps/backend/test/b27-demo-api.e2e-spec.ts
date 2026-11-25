import 'reflect-metadata';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../src/trading-api/trading-api-admin.guard.js';
import { B27DemoController } from '../src/b27-demo/b27-demo.controller.js';
import { B27TradingHistoryController } from '../src/b27-demo/b27-trading-history.controller.js';
import { B27WalletController } from '../src/b27-demo/b27-wallet.controller.js';

const readKey = 'B27_ONLY_LOCAL_TEST_READ_KEY_2026_32_PLUS_CHARS';
const buyerId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const intervalStart = new Date('2026-10-03T12:00:00.000Z');
const intervalEnd = new Date('2026-10-03T13:00:00.000Z');
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const buyerAddress = '0x1111111111111111111111111111111111111111';
const sellerAddress = '0x2222222222222222222222222222222222222222';

const user = {
  id: buyerId,
  name: 'Demo Buyer',
  preferredEnergyType: 'SOLAR',
  wallet: { hederaAccountId: '0.0.1234', evmAddress: buyerAddress },
  walletProvisioning: null,
};

function allocation(
  id: string,
  chainId: number,
  outcome: string,
  buyer: string,
  seller: string,
  quantityWh: bigint,
  amountBaseUnits: bigint,
) {
  const hasHederaEvidence = chainId === 296;
  return {
    id, marketId: hash('a'), buyerId: buyer, sellerId: seller,
    buyerAddress, sellerAddress, quantityWh,
    unitPriceMicrousdPerKwh: 100_000n, amountBaseUnits,
    buyer: { name: 'Demo Buyer' }, seller: { name: 'Demo Seller' },
    market: { intervalStart, intervalEnd },
    intent: {
      chainId, status: 'CONFIRMED', amountBaseUnits,
      tokenAddress: '0x3333333333333333333333333333333333333333',
      contractAddress: '0x3333333333333333333333333333333333333333',
      evidence: hasHederaEvidence ? [{
        chainId: 296, receiptStatus: 'SUCCESS', verificationStatus: 'VERIFIED',
        amountBaseUnits, buyerAddress, sellerAddress,
        txHash: hash('e'), confirmedAt: intervalEnd,
        tokenAddress: '0x3333333333333333333333333333333333333333',
        contractAddress: '0x3333333333333333333333333333333333333333',
        logIndex: 0,
      }] : [],
      b25LocalBinding: hasHederaEvidence ? null : {
        attempt: {
          transactionHash: hash('f'),
          outcomes: [{ outcome, verifiedAt: intervalEnd, blockNumber: 51n }],
        },
      },
    },
  };
}

// Three allocations: one canonical local buy, one superseded local buy,
// and one confirmed Hedera sale. The superseded buy must NOT count as paid.
const fixtures = [
  allocation(hash('1'), 31337, 'SUCCESS', buyerId, sellerId, 50n, 5_000n),
  allocation(hash('2'), 31337, 'NONCANONICAL', buyerId, sellerId, 90n, 9_000n),
  allocation(hash('3'), 296, 'SUCCESS', sellerId, buyerId, 75n, 8_000n),
];

const mockDb = {
  user: {
    findMany: vi.fn(async () => [user]),
    findFirst: vi.fn(async (args: { where: { id: string; accountOrigin: string } }) =>
      args.where.id === buyerId && args.where.accountOrigin === 'SIMULATED' ? user : null),
  },
  v2SnapshotMeasurement: {
    findMany: vi.fn(async () => [{
      productionWh: 1_500n,
      consumptionWh: 1_000n,
      snapshot: { id: '33333333-3333-4333-8333-333333333333', intervalStart, intervalEnd },
    }]),
  },
  energyRecord: {
    findMany: vi.fn(async () => [] as Array<{
      snapshotId: string;
      timeSlot: Date;
      productionWh: bigint;
      consumptionWh: bigint;
    }>),
  },
  v2Allocation: {
    findMany: vi.fn(async (query: { take: number; skip?: number }) => {
      if (query.take === 5001) return fixtures;
      return fixtures.slice(query.skip ?? 0, (query.skip ?? 0) + query.take);
    }),
  },
};

const dateQuery = 'from=2026-10-03T00%3A00%3A00Z&to=2026-10-04T00%3A00%3A00Z';
const root = '/internal/v2/demo';

describe('B27 presenter endpoints (HTTP integration; mocked Prisma)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [B27DemoController, B27TradingHistoryController, B27WalletController],
      providers: [
        TradingApiAdminGuard,
        { provide: ConfigService, useValue: { get: (key: string) =>
          key === 'TRADING_API_READ_ADMIN_KEY' ? readKey : undefined } },
        { provide: PrismaService, useValue: { client: mockDb } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('rejects missing and invalid admin keys for all three endpoints', async () => {
    const paths = [
      `${root}/users`,
      `${root}/users/${buyerId}/energy?${dateQuery}`,
      `${root}/users/${buyerId}/trades`,
      `${root}/users/${buyerId}/wallet?${dateQuery}`,
    ];
    for (const path of paths) {
      await request(app.getHttpServer()).get(path).expect(403);
      await request(app.getHttpServer())
        .get(path).set('x-trading-read-key', 'not-the-right-key').expect(403);
    }
  });

  it('lists only the simulated households returned by the scoped query', async () => {
    const res = await request(app.getHttpServer())
      .get(`${root}/users`).set('x-trading-read-key', readKey).expect(200);
    expect(res.body.users).toEqual([{
      userId: buyerId, name: 'Demo Buyer', energyType: 'SOLAR',
    }]);
    expect(JSON.stringify(res.body)).not.toContain('walletProvisioning');
    expect(mockDb.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountOrigin: 'SIMULATED' },
    }));
  });

  it('returns production, consumption, net energy and role', async () => {
    const res = await request(app.getHttpServer())
      .get(`${root}/users/${buyerId}/energy?${dateQuery}`)
      .set('x-trading-read-key', readKey).expect(200);
    expect(res.body.totals).toEqual({
      productionWh: '1500', consumptionWh: '1000',
      netEnergyWh: '500', recordedHours: 1,
    });
    expect(res.body.hours[0].role).toBe('SELLER');
    expect(mockDb.v2SnapshotMeasurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: buyerId }) }),
    );
    await request(app.getHttpServer())
      .get(`${root}/users/${buyerId}/energy?from=bad&to=bad`)
      .set('x-trading-read-key', readKey).expect(400);
  });

  it('merges distinct imported hours without double-counting a finalized V2 hour', async () => {
    const previousHour = new Date('2026-10-03T11:00:00.000Z');
    mockDb.energyRecord.findMany.mockResolvedValueOnce([
      {
        snapshotId: '44444444-4444-4444-8444-444444444444',
        timeSlot: previousHour,
        productionWh: 400n,
        consumptionWh: 600n,
      },
      {
        // Old B11 reading at the same slot as the authoritative V2 reading.
        // It must NOT add a second chart point or change the totals.
        snapshotId: '55555555-5555-4555-8555-555555555555',
        timeSlot: intervalStart,
        productionWh: 999_999n,
        consumptionWh: 999_999n,
      },
    ]);
    const res = await request(app.getHttpServer())
      .get(`${root}/users/${buyerId}/energy?${dateQuery}`)
      .set('x-trading-read-key', readKey).expect(200);
    expect(res.body.source).toBe('MIXED_FINALIZED_V2_AND_TRUSTED_IMPORTED_LEGACY_HOURS');
    expect(res.body.totals).toEqual({
      productionWh: '1900', consumptionWh: '1600',
      netEnergyWh: '300', recordedHours: 2,
    });
    expect(res.body.hours.map((h: { intervalStart: string }) => h.intervalStart)).toEqual([
      '2026-10-03T11:00:00.000Z', '2026-10-03T12:00:00.000Z',
    ]);
    expect(res.body.hours.map((h: { source: string }) => h.source)).toEqual([
      'TRUSTED_IMPORTED_LEGACY_ENERGY_RECORD', 'STORED_FINALIZED_HOURLY_SNAPSHOT',
    ]);
  });

  it('distinguishes confirmed and noncanonical trades without fake explorer links', async () => {
    const res = await request(app.getHttpServer())
      .get(`${root}/users/${buyerId}/trades`)
      .set('x-trading-read-key', readKey).expect(200);
    expect(res.body.trades).toHaveLength(3);
    expect(mockDb.v2Allocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({
        OR: [{ buyerId }, { sellerId: buyerId }],
        status: 'VALIDATED', plan: { status: 'AUTHORITATIVE' },
      }) }),
    );
    expect(res.body.trades[0].paymentStatus).toBe('CONFIRMED_LOCAL');
    expect(res.body.trades[1].paymentStatus).toBe('NEEDS_RECONCILIATION');
    expect(res.body.trades[1].confirmedPaymentBaseUnits).toBe('0');
    expect(res.body.trades[2].paymentStatus).toBe('RECORDED_EVIDENCE_ONLY');
    expect(res.body.trades.every((t: { explorerUrl: unknown }) => t.explorerUrl === null)).toBe(true);
  });

  it('separates local confirmations from recorded Hedera evidence', async () => {
    const res = await request(app.getHttpServer())
      .get(`${root}/users/${buyerId}/wallet?${dateQuery}`)
      .set('x-trading-read-key', readKey).expect(200);
    expect(res.body.confirmedTradingActivity.hederaTestnet).toBeNull();
    expect(res.body.confirmedTradingActivity.localHardhat).toMatchObject({
      confirmedTrades: 1, boughtWh: '50', spentBaseUnits: '5000',
      earnedBaseUnits: '0',
    });
    expect(res.body.recordedTradingActivity.hederaTestnet).toMatchObject({
      confirmedTrades: 1, soldWh: '75', earnedBaseUnits: '8000',
      spentBaseUnits: '0',
    });
    expect(res.body.token.onChainBalanceBaseUnits).toBeNull();
    expect(res.body.token.balanceStatus).toBe('NOT_VERIFIED');
    await request(app.getHttpServer())
      .get(`${root}/users/99999999-9999-4999-8999-999999999999/wallet?${dateQuery}`)
      .set('x-trading-read-key', readKey).expect(404);
  });
});
