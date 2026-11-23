import 'reflect-metadata';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../src/trading-api/trading-api-admin.guard.js';
import { B27TradingHistoryController } from '../src/b27-demo/b27-trading-history.controller.js';
import { B27HederaProofController } from '../src/b27-demo/b27-hedera-proof.controller.js';

// Disable real RPC access inside this HTTP test.
// The actual verifier has separate mocked-RPC unit tests.
const verifyMock = vi.hoisted(() => vi.fn());

vi.mock('../src/b27-demo/b27-hedera-proof.js', () => ({
  verifyB27HederaTransfer: verifyMock,
}));

const key = 'B27_LOCAL_FIXTURE_READ_KEY_2026_32_CHARS';
const root = '/internal/v2/demo';

const buyerId =
  '11111111-1111-4111-8111-111111111111';

const sellerId =
  '22222222-2222-4222-8222-222222222222';

const outsiderId =
  '33333333-3333-4333-8333-333333333333';

const buyerAddress = '0x' + '11'.repeat(20);
const sellerAddress = '0x' + '22'.repeat(20);
const tokenAddress = '0x' + '33'.repeat(20);

const hash = (digit: string) =>
  `0x${digit.repeat(64)}`;

const start = new Date('2026-10-03T12:00:00Z');
const end = new Date('2026-10-03T13:00:00Z');

const otherStart = new Date('2026-10-04T12:00:00Z');
const otherEnd = new Date('2026-10-04T13:00:00Z');

type Outcome = 'SUCCESS' | 'NONCANONICAL';

function fixture(
  digit: string,
  chainId: number,
  outcome: Outcome,
  intervalStart: Date = start,
  intervalEnd: Date = end,
  mismatchedEvidence = false,
) {
  const hedera = chainId === 296;

  const amountBaseUnits = 500_000n;

  return {
    id: hash(digit),
    marketId: hash('a'),
    buyerId,
    sellerId,
    buyerAddress,
    sellerAddress,
    quantityWh: 5_000n,
    unitPriceMicrousdPerKwh: 100_000n,
    amountBaseUnits,

    buyer: { name: 'Demo Buyer' },
    seller: { name: 'Demo Seller' },

    market: {
      intervalStart,
      intervalEnd,
    },

    intent: {
      chainId,
      status: 'CONFIRMED',
      tokenAddress,
      contractAddress: hedera ? tokenAddress : null,
      amountBaseUnits,

      evidence: hedera
        ? [{
            chainId: 296,
            receiptStatus: 'SUCCESS',
            verificationStatus: 'VERIFIED',
            txHash: hash('e'),
            tokenAddress,
            contractAddress: tokenAddress,
            buyerAddress,
            sellerAddress,
            amountBaseUnits: mismatchedEvidence
              ? 600_000n
              : amountBaseUnits,
            logIndex: 0,
            confirmedAt: intervalEnd,
          }]
        : [],

      b25LocalBinding: hedera
        ? null
        : {
            attempt: {
              transactionHash: hash('f'),
              outcomes: [{
                outcome,
                verifiedAt: intervalEnd,
                blockNumber: 51n,
              }],
            },
          },
    },
  };
}

const fixtures = [
  // Recorded Hedera evidence, matching allocation
  fixture('1', 296, 'SUCCESS'),

  // Local confirmed settlement
  fixture('2', 31337, 'SUCCESS'),

  // Superseded local outcome
  fixture('3', 31337, 'NONCANONICAL'),

  // Incorrect Hedera payment amount
  fixture('4', 296, 'SUCCESS', start, end, true),

  // Allocation outside selected date window
  fixture('5', 296, 'SUCCESS', otherStart, otherEnd),
];

type Where = {
  id?: string;
  OR?: Array<{
    buyerId?: string;
    sellerId?: string;
  }>;
  status?: string;
  plan?: { status?: string };
  market?: {
    namespace?: string;
    mode?: string;
    intervalStart?: {
      gte?: Date;
      lt?: Date;
    };
  };
};

function matching(row: typeof fixtures[number], where: Where) {
  if (where.id && row.id !== where.id) {
    return false;
  }

  if (where.status !== 'VALIDATED') {
    return false;
  }

  if (where.plan?.status !== 'AUTHORITATIVE') {
    return false;
  }

  if (
    where.market?.namespace !== 'hourly' ||
    where.market?.mode !== 'HOURLY'
  ) {
    return false;
  }

  const participant = where.OR?.some(
    (entry) =>
      entry.buyerId === row.buyerId ||
      entry.sellerId === row.sellerId,
  );

  if (!participant) return false;

  const interval = where.market.intervalStart;

  if (
    interval?.gte &&
    row.market.intervalStart < interval.gte
  ) {
    return false;
  }

  if (
    interval?.lt &&
    row.market.intervalStart >= interval.lt
  ) {
    return false;
  }

  return true;
}

const mockDb = {
  user: {
    findFirst: vi.fn(async (
      args: {
        where: {
          id: string;
          accountOrigin: string;
        };
      },
    ) => {
      if (args.where.accountOrigin !== 'SIMULATED') {
        return null;
      }

      const names = new Map([
        [buyerId, 'Demo Buyer'],
        [sellerId, 'Demo Seller'],
        [outsiderId, 'Unrelated Household'],
      ]);

      const name = names.get(args.where.id);

      return name
        ? { id: args.where.id, name }
        : null;
    }),
  },

  v2Allocation: {
    findMany: vi.fn(async (
      query: {
        where: Where;
        skip?: number;
        take: number;
      },
    ) => {
      const selected = fixtures.filter(
        (row) => matching(row, query.where),
      );

      const offset = query.skip ?? 0;

      return selected.slice(
        offset,
        offset + query.take,
      );
    }),

    findFirst: vi.fn(async (
      query: { where: Where },
    ) => {
      return fixtures.find(
        (row) => matching(row, query.where),
      ) ?? null;
    }),
  },
};

describe('B27.7 non-empty V2 HTTP integration', () => {
  let app: INestApplication;

  const history = (userId = buyerId) =>
    `${root}/users/${userId}/trades`;

  const proof = (
    userId = buyerId,
    allocationId = fixtures[0].id,
  ) =>
    `${root}/users/${userId}/trades/${allocationId}/verification`;

  const authenticatedGet = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('x-trading-read-key', key);

  beforeAll(async () => {
    verifyMock.mockResolvedValue({
      readOnly: true,
      status: 'UNAVAILABLE',
      reason: 'Mocked: no real Hedera RPC request',
      confirmedPaymentBaseUnits: null,
      transactionHash: null,
      explorerUrl: null,
      checkedAt: null,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [
        B27TradingHistoryController,
        B27HederaProofController,
      ],
      providers: [
        TradingApiAdminGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              name === 'TRADING_API_READ_ADMIN_KEY'
                ? key
                : undefined,
          },
        },
        {
          provide: PrismaService,
          useValue: { client: mockDb },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer())
      .get(history())
      .expect(403);

    await request(app.getHttpServer())
      .get(proof())
      .expect(403);
  });

  it('returns non-empty authoritative allocations', async () => {
    const response = await authenticatedGet(
      history() + '?limit=50&offset=0',
    ).expect(200);

    expect(response.body.trades).toHaveLength(5);

    expect(mockDb.v2Allocation.findMany)
      .toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { buyerId },
              { sellerId: buyerId },
            ],
            status: 'VALIDATED',
            plan: { status: 'AUTHORITATIVE' },
          }),
        }),
      );
  });

  it('filters allocations by selected UTC dates', async () => {
    const response = await authenticatedGet(
      history() +
      '?from=2026-10-03T00%3A00%3A00Z' +
      '&to=2026-10-04T00%3A00%3A00Z',
    ).expect(200);

    expect(response.body.trades).toHaveLength(4);

    const ids = response.body.trades.map(
      (trade: { allocationId: string }) =>
        trade.allocationId,
    );

    expect(ids).not.toContain(fixtures[4].id);

    expect(mockDb.v2Allocation.findMany)
      .toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            market: expect.objectContaining({
              intervalStart: {
                gte: new Date('2026-10-03T00:00:00Z'),
                lt: new Date('2026-10-04T00:00:00Z'),
              },
            }),
          }),
        }),
      );
  });

  it('distinguishes stored evidence from payment proof', async () => {
    const response = await authenticatedGet(
      history(),
    ).expect(200);

    const trades = response.body.trades;

    expect(trades[0].paymentStatus)
      .toBe('RECORDED_EVIDENCE_ONLY');

    expect(trades[0].evidenceConsistency)
      .toBe('RECORDED_CONSISTENT');

    expect(trades[0].confirmedPaymentBaseUnits)
      .toBe('0');

    expect(trades[0].explorerUrl)
      .toBeNull();

    expect(trades[1].paymentStatus)
      .toBe('CONFIRMED_LOCAL');

    expect(trades[1].confirmedPaymentBaseUnits)
      .toBe('500000');

    expect(trades[2].paymentStatus)
      .toBe('NEEDS_RECONCILIATION');

    expect(trades[2].confirmedPaymentBaseUnits)
      .toBe('0');

    expect(trades[3].paymentStatus)
      .toBe('NEEDS_RECONCILIATION');

    expect(trades[3].evidenceConsistency)
      .toBe('MISMATCH');

    expect(trades[3].confirmedPaymentBaseUnits)
      .toBe('0');

    for (const trade of trades) {
      expect(trade.paymentStatus)
        .not.toBe('CONFIRMED_HEDERA');

      expect(trade.explorerUrl)
        .toBeNull();
    }
  });

  it('preserves pagination for non-empty results', async () => {
    const response = await authenticatedGet(
      history() + '?limit=2&offset=0',
    ).expect(200);

    expect(response.body.trades).toHaveLength(2);
    expect(response.body.pagination.hasMore).toBe(true);
    expect(response.body.pagination.nextOffset).toBe(2);

    expect(mockDb.v2Allocation.findMany)
      .toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 3,
        }),
      );
  });

  it('rejects invalid date periods', async () => {
    await authenticatedGet(
      history() + '?from=invalid&to=invalid',
    ).expect(400);

    await authenticatedGet(
      history() +
      '?from=2026-10-04T00%3A00%3A00Z' +
      '&to=2026-10-03T00%3A00%3A00Z',
    ).expect(400);
  });

  it('prevents unrelated household access', async () => {
    const response = await authenticatedGet(
      history(outsiderId),
    ).expect(200);

    expect(response.body.trades).toHaveLength(0);

    await authenticatedGet(
      proof(outsiderId),
    ).expect(404);
  });

  it('allows a participant to inspect a settlement', async () => {
    const response = await authenticatedGet(
      proof(buyerId),
    ).expect(200);

    expect(response.body.allocationId)
      .toBe(fixtures[0].id);

    expect(response.body.readOnly)
      .toBe(true);

    expect(response.body.status)
      .toBe('UNAVAILABLE');

    expect(verifyMock).toHaveBeenCalledOnce();

    const [input] = verifyMock.mock.calls[0];

    expect(input.buyerAddress)
      .toBe(buyerAddress);

    expect(input.sellerAddress)
      .toBe(sellerAddress);

    expect(input.amountBaseUnits)
      .toBe(500_000n);

    expect(input.intent.evidence.txHash)
      .toBe(hash('e'));
  });

  it('allows the actual seller to inspect the same allocation', async () => {
    const response = await authenticatedGet(
      proof(sellerId),
    ).expect(200);

    expect(response.body.allocationId)
      .toBe(fixtures[0].id);

    expect(response.body.readOnly)
      .toBe(true);
  });

  it('rejects nonexistent allocations', async () => {
    await authenticatedGet(
      proof(buyerId, hash('9')),
    ).expect(404);
  });
});
