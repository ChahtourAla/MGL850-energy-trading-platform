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

@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27MatchingController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private parseDate(value: string | undefined): Date {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      throw new BadRequestException('Expected a UTC ISO timestamp');
    }

    const result = new Date(value);

    if (
      !Number.isFinite(result.getTime()) ||
      ![result.toISOString(), result.toISOString().replace('.000Z', 'Z')].includes(value)
    ) {
      throw new BadRequestException('Invalid UTC timestamp');
    }

    return result;
  }

  @Get('users/:userId/matches')
  @Header('Cache-Control', 'no-store')
  async getMatches(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = this.parseDate(from);
    const end = this.parseDate(to);

    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 31 * 86400000) {
      throw new BadRequestException('Choose a range between zero and 31 days');
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

    const matches = await db.match.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        timeSlot: {
          gte: start,
          lt: end,
        },
      },
      select: {
        id: true,
        timeSlot: true,
        buyerId: true,
        sellerId: true,
        buyer: {
          select: { name: true },
        },
        seller: {
          select: { name: true },
        },
        quantityWh: true,
        unitPriceMicrousdPerKwh: true,
        totalAmountMicrousd: true,
        sellerEnergyType: true,
        status: true,
        algorithmVersion: true,
        trade: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      orderBy: [{ timeSlot: 'desc' }, { id: 'desc' }],
      take: 51,
    });

    const hasMore = matches.length > 50;

    return {
      simulationOnly: true,
      source: 'PERSISTED_B12_MATCHES',
      user,
      period: {
        from: start.toISOString(),
        to: end.toISOString(),
      },
      hasMore,
      matches: matches.slice(0, 50).map((match) => {
        const side = match.buyerId === userId ? 'BUYER' : 'SELLER';

        return {
          matchId: match.id,
          timeSlot: match.timeSlot.toISOString(),
          side,
          counterparty: {
            userId: side === 'BUYER' ? match.sellerId : match.buyerId,
            name: side === 'BUYER' ? match.seller.name : match.buyer.name,
          },
          quantityWh: match.quantityWh.toString(),
          unitPriceMicrousdPerKwh: match.unitPriceMicrousdPerKwh.toString(),
          quotedTotalMicrousd: match.totalAmountMicrousd.toString(),
          energyType: match.sellerEnergyType,
          matchingStatus: match.status,
          algorithmVersion: match.algorithmVersion,
          trade: match.trade
            ? {
                tradeId: match.trade.id,
                status: match.trade.status,
              }
            : null,

          // A match or trade record alone is not proof of payment.
          paymentVerification: 'NOT_VERIFIED',
          explorerUrl: null,
        };
      }),
    };
  }
}
