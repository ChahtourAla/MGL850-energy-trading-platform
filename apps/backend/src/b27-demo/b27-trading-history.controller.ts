import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';
import { describeB27HederaEvidence } from './b27-evidence-check.js';

@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27TradingHistoryController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private pageNumber(value: string | undefined, fallback: number, maximum: number): number {
    if (value === undefined) return fallback;

    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new BadRequestException('Invalid pagination value');
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number) || number > maximum) {
      throw new BadRequestException('Pagination limit exceeded');
    }

    return number;
  }

  private parseUtc(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      throw new BadRequestException('Invalid UTC timestamp');
    }

    const date = new Date(value);

    if (
      !Number.isFinite(date.getTime()) ||
      ![date.toISOString(), date.toISOString().replace('.000Z', 'Z')].includes(value)
    ) {
      throw new BadRequestException('Invalid UTC timestamp');
    }

    return date;
  }

  @Get('users/:userId/trades')
  @Header('Cache-Control', 'no-store')
  async listTrades(
    @Param('userId', new ParseUUIDPipe()) userId: string,

    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
  ) {
    const limit = this.pageNumber(rawLimit, 20, 50);
    const offset = this.pageNumber(rawOffset, 0, 10000);

    if ((rawFrom === undefined) !== (rawTo === undefined)) {
      throw new BadRequestException('Both from and to must be provided');
    }

    const start = rawFrom === undefined ? null : this.parseUtc(rawFrom);

    const end = rawTo === undefined ? null : this.parseUtc(rawTo);

    if (
      start &&
      end &&
      (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 31 * 86400000)
    ) {
      throw new BadRequestException('Period must be positive and at most 31 days');
    }

    if (limit === 0) {
      throw new BadRequestException('Limit must be positive');
    }

    const db = this.prisma.client;

    const user = await db.user.findFirst({
      where: {
        id: userId,
        accountOrigin: 'SIMULATED',
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Demo household not found');
    }

    const records = await db.v2Allocation.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: 'VALIDATED',
        plan: { status: 'AUTHORITATIVE' },

        market: {
          namespace: 'hourly',
          mode: 'HOURLY',
          ...(start && end
            ? {
                intervalStart: {
                  gte: start,
                  lt: end,
                },
              }
            : {}),
        },
      },
      orderBy: [{ market: { intervalStart: 'desc' } }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
      select: {
        id: true,
        marketId: true,
        buyerId: true,
        sellerId: true,
        buyerAddress: true,
        sellerAddress: true,
        quantityWh: true,
        unitPriceMicrousdPerKwh: true,
        amountBaseUnits: true,
        buyer: { select: { name: true } },
        seller: { select: { name: true } },
        market: {
          select: {
            intervalStart: true,
            intervalEnd: true,
          },
        },

        intent: {
          select: {
            chainId: true,
            status: true,
            tokenAddress: true,
            contractAddress: true,
            amountBaseUnits: true,

            evidence: {
              orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                chainId: true,
                receiptStatus: true,
                verificationStatus: true,
                txHash: true,
                contractAddress: true,
                tokenAddress: true,
                buyerAddress: true,
                sellerAddress: true,
                amountBaseUnits: true,
                logIndex: true,
                confirmedAt: true,
              },
            },

            b25LocalBinding: {
              select: {
                attempt: {
                  select: {
                    transactionHash: true,
                    outcomes: {
                      orderBy: { sequence: 'desc' },
                      take: 1,
                      select: {
                        outcome: true,
                        verifiedAt: true,
                        blockNumber: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const hasMore = records.length > limit;

    const trades = records.slice(0, limit).map((trade) => {
      const side = trade.buyerId === userId ? 'BOUGHT' : 'SOLD';

      const intent = trade.intent;
      const localAttempt = intent?.b25LocalBinding?.attempt;
      const latestOutcome = localAttempt?.outcomes[0];
      const evidence = intent?.evidence[0];

      const confirmedLocal =
        intent?.chainId === 31337 &&
        intent.status === 'CONFIRMED' &&
        latestOutcome?.outcome === 'SUCCESS';

      const hederaView = describeB27HederaEvidence(
        {
          buyerAddress: trade.buyerAddress,
          sellerAddress: trade.sellerAddress,
          amountBaseUnits: trade.amountBaseUnits,
        },
        intent,
        evidence ?? null,
      );

      const paymentStatus = confirmedLocal
        ? 'CONFIRMED_LOCAL'
        : intent?.chainId === 296
          ? hederaView.paymentStatus
          : latestOutcome?.outcome === 'NONCANONICAL'
            ? 'NEEDS_RECONCILIATION'
            : (intent?.status ?? 'NOT_SUBMITTED');

      return {
        allocationId: trade.id,
        marketId: trade.marketId,
        intervalStart: trade.market.intervalStart.toISOString(),
        intervalEnd: trade.market.intervalEnd.toISOString(),

        side,
        counterparty: {
          userId: side === 'BOUGHT' ? trade.sellerId : trade.buyerId,
          name: side === 'BOUGHT' ? trade.seller.name : trade.buyer.name,
        },

        quantityWh: trade.quantityWh.toString(),
        unitPriceMicrousdPerKwh: trade.unitPriceMicrousdPerKwh.toString(),

        expectedPaymentBaseUnits: trade.amountBaseUnits.toString(),
        confirmedPaymentBaseUnits: confirmedLocal ? trade.amountBaseUnits.toString() : '0',

        evidenceConsistency: hederaView.evidenceConsistency,

        paymentToken: 'TEUSD',
        paymentStatus,

        network:
          intent?.chainId === 31337
            ? 'LOCAL_HARDHAT'
            : intent?.chainId === 296
              ? 'HEDERA_TESTNET'
              : 'NOT_ASSIGNED',

        transactionHash:
          intent?.chainId === 296
            ? hederaView.transactionHash
            : latestOutcome
              ? (localAttempt?.transactionHash ?? null)
              : null,

        verifiedAt:
          intent?.chainId === 296
            ? null
            : latestOutcome
              ? latestOutcome.verifiedAt.toISOString()
              : null,

        recordedConfirmedAt: intent?.chainId === 296 ? hederaView.recordedConfirmedAt : null,

        blockNumber:
          intent?.chainId === 31337 ? (latestOutcome?.blockNumber.toString() ?? null) : null,

        // Added after verified Hedera transaction-ID resolution.
        explorerUrl: null,
      };
    });

    return {
      simulationOnly: true,
      user,
      period:
        start && end
          ? {
              from: start.toISOString(),
              to: end.toISOString(),
            }
          : null,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      trades,
    };
  }
}
