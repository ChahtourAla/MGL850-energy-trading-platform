import {
  BadRequestException,
  ConflictException,
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

type JournalEvent = {
  source: string;
  operation: string;
  status: string;
  chainId: number | null;
  transactionHash: string | null;
  recordedAt: string;
  confirmedAt: string | null;
};

@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27LifecycleController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private parseUtc(value: string | undefined): Date {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
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

  @Get('users/:userId/lifecycle')
  @Header('Cache-Control', 'no-store')
  async getLifecycle(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = this.parseUtc(from);
    const end = this.parseUtc(to);

    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 31 * 86400000) {
      throw new BadRequestException('Period must be positive and at most 31 days');
    }

    const db = this.prisma.client;

    const user = await db.user.findFirst({
      where: {
        id: userId,
        accountOrigin: 'SIMULATED',
      },
      select: { id: true, name: true },
    });

    if (!user) {
      throw new NotFoundException('Demo household not found');
    }

    const rows = await db.match.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        timeSlot: {
          gte: start,
          lt: end,
        },
      },
      orderBy: [{ timeSlot: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true,
        timeSlot: true,
        buyerId: true,
        sellerId: true,
        quantityWh: true,
        totalAmountMicrousd: true,
        status: true,

        buyer: {
          select: { name: true },
        },
        seller: {
          select: { name: true },
        },

        trade: {
          select: {
            id: true,
            matchId: true,
            buyerId: true,
            sellerId: true,
            quantityWh: true,
            totalAmountMicrousd: true,
            status: true,
            onChainTradeId: true,
            deliveryStart: true,
            deliveryDeadline: true,
            createdAt: true,
            updatedAt: true,

            deliveryRecords: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                status: true,
                expectedWh: true,
                deliveredWh: true,
                timeSlot: true,
              },
            },

            blockchainTransactions: {
              orderBy: { createdAt: 'desc' },
              take: 20,
              select: {
                operation: true,
                status: true,
                transactionHash: true,
                confirmedAt: true,
                createdAt: true,
              },
            },
          },
        },

        b14TransactionIntents: {
          orderBy: { createdAt: 'asc' },
          select: {
            operation: true,
            status: true,
            chainId: true,
            txHash: true,
            createdAt: true,
            confirmedAt: true,
          },
        },

        b16OracleIntent: {
          select: {
            status: true,
            txHash: true,
            createdAt: true,
            confirmedAt: true,
          },
        },

        b17OperatorIntents: {
          orderBy: { createdAt: 'asc' },
          select: {
            operation: true,
            status: true,
            chainId: true,
            txHash: true,
            createdAt: true,
            confirmedAt: true,
          },
        },
      },
    });

    const hasMore = rows.length > 50;

    const items = rows.slice(0, 50).map((match) => {
      const trade = match.trade;

      // Never present an inconsistent trade as belonging
      // to the selected energy match.
      if (
        trade &&
        (trade.matchId !== match.id ||
          trade.buyerId !== match.buyerId ||
          trade.sellerId !== match.sellerId ||
          trade.quantityWh !== match.quantityWh ||
          trade.totalAmountMicrousd !== match.totalAmountMicrousd)
      ) {
        throw new ConflictException('Stored trade does not match its source allocation');
      }

      const events: JournalEvent[] = [];

      for (const intent of match.b14TransactionIntents) {
        events.push({
          source: 'B14_TRANSACTION_INTENT',
          operation: intent.operation,
          status: intent.status,
          chainId: intent.chainId,
          transactionHash: intent.txHash,
          recordedAt: intent.createdAt.toISOString(),
          confirmedAt: intent.confirmedAt?.toISOString() ?? null,
        });
      }

      if (match.b16OracleIntent) {
        const oracle = match.b16OracleIntent;

        events.push({
          source: 'B16_ORACLE_INTENT',
          operation: 'DELIVERY_ORACLE',
          status: oracle.status,
          chainId: null,
          transactionHash: oracle.txHash,
          recordedAt: oracle.createdAt.toISOString(),
          confirmedAt: oracle.confirmedAt?.toISOString() ?? null,
        });
      }

      for (const intent of match.b17OperatorIntents) {
        events.push({
          source: 'B17_OPERATOR_INTENT',
          operation: intent.operation,
          status: intent.status,
          chainId: intent.chainId,
          transactionHash: intent.txHash,
          recordedAt: intent.createdAt.toISOString(),
          confirmedAt: intent.confirmedAt?.toISOString() ?? null,
        });
      }

      for (const tx of trade?.blockchainTransactions ?? []) {
        events.push({
          source: 'BLOCKCHAIN_TRANSACTION_JOURNAL',
          operation: tx.operation,
          status: tx.status,
          chainId: null,
          transactionHash: tx.transactionHash,
          recordedAt: tx.createdAt.toISOString(),
          confirmedAt: tx.confirmedAt?.toISOString() ?? null,
        });
      }

      events.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

      const delivery = trade?.deliveryRecords[0];

      return {
        matchId: match.id,
        intervalStart: match.timeSlot.toISOString(),
        side: match.buyerId === userId ? 'BOUGHT' : 'SOLD',
        counterparty: match.buyerId === userId ? match.seller.name : match.buyer.name,
        quantityWh: match.quantityWh.toString(),
        quotedAmountMicrousd: match.totalAmountMicrousd.toString(),
        matchingStatus: match.status,

        trade: trade
          ? {
              tradeId: trade.id,
              status: trade.status,
              onChainTradeId: trade.onChainTradeId?.toString() ?? null,
              createdAt: trade.createdAt.toISOString(),
              updatedAt: trade.updatedAt.toISOString(),
              deliveryStart: trade.deliveryStart.toISOString(),
              deliveryDeadline: trade.deliveryDeadline.toISOString(),
              latestDelivery: delivery
                ? {
                    status: delivery.status,
                    expectedWh: delivery.expectedWh.toString(),
                    deliveredWh: delivery.deliveredWh.toString(),
                    timeSlot: delivery.timeSlot.toISOString(),
                  }
                : null,
            }
          : null,

        lifecycleStage: !trade
          ? 'MATCH_ONLY'
          : events.length === 0
            ? 'TRADE_RECORDED'
            : 'OPERATIONS_RECORDED',

        paymentVerification: 'NOT_INDEPENDENTLY_VERIFIED',

        // Do not infer a Hedera explorer link from
        // a stored hash or journal status alone.
        explorerUrl: null,

        events,
      };
    });

    return {
      presenterMode: true,
      readOnly: true,
      source: 'B12_B17_RECORDED_LIFECYCLE',
      user,
      hasMore,
      items,
    };
  }
}
