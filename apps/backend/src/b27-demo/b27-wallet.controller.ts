import { assessB27HederaEvidence } from './b27-evidence-check.js';
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

type TradingTotals = {
  confirmedTrades: number;
  boughtWh: bigint;
  soldWh: bigint;
  spentBaseUnits: bigint;
  earnedBaseUnits: bigint;
};

function newTotals(): TradingTotals {
  return {
    confirmedTrades: 0,
    boughtWh: 0n,
    soldWh: 0n,
    spentBaseUnits: 0n,
    earnedBaseUnits: 0n,
  };
}

function serializeTotals(t: TradingTotals) {
  return {
    confirmedTrades: t.confirmedTrades,
    boughtWh: t.boughtWh.toString(),
    soldWh: t.soldWh.toString(),
    spentBaseUnits: t.spentBaseUnits.toString(),
    earnedBaseUnits: t.earnedBaseUnits.toString(),
    netTradeFlowBaseUnits: (t.earnedBaseUnits - t.spentBaseUnits).toString(),
  };
}

@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27WalletController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private parseUtc(value: string | undefined): Date {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      throw new BadRequestException('Provide a valid UTC ISO timestamp');
    }

    const date = new Date(value);

    if (
      !Number.isFinite(date.getTime()) ||
      ![date.toISOString(), date.toISOString().replace('.000Z', 'Z')].includes(value)
    ) {
      throw new BadRequestException('Invalid timestamp');
    }

    return date;
  }

  @Get('users/:userId/wallet')
  @Header('Cache-Control', 'no-store')
  async getWalletOverview(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = this.parseUtc(from);
    const end = this.parseUtc(to);

    const duration = end.getTime() - start.getTime();

    if (duration <= 0 || duration > 31 * 86400000) {
      throw new BadRequestException('Choose a period between 1 millisecond and 31 days');
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
        wallet: {
          select: {
            hederaAccountId: true,
            evmAddress: true,
          },
        },
        walletProvisioning: {
          select: { state: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Simulated household not found');
    }

    const allocations = await db.v2Allocation.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: 'VALIDATED',
        plan: { status: 'AUTHORITATIVE' },
        market: {
          namespace: 'hourly',
          mode: 'HOURLY',
          intervalStart: {
            gte: start,
            lt: end,
          },
        },
      },
      select: {
        buyerId: true,
        sellerId: true,
        buyerAddress: true,
        sellerAddress: true,
        quantityWh: true,
        amountBaseUnits: true,
        intent: {
          select: {
            chainId: true,
            status: true,
            amountBaseUnits: true,
            tokenAddress: true,
            contractAddress: true,
            evidence: {
              orderBy: [
                { confirmedAt: 'desc' },
                { id: 'desc' },
              ],
              take: 1,
              select: {
                chainId: true,
                receiptStatus: true,
                verificationStatus: true,
                txHash: true,
                tokenAddress: true,
                contractAddress: true,
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
                    outcomes: {
                      orderBy: { sequence: 'desc' },
                      take: 1,
                      select: { outcome: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      take: 5001,
    });

    if (allocations.length > 5000) {
      throw new BadRequestException('Too many trades; choose a shorter date range');
    }

    const local = newTotals();
    const hederaRecorded = newTotals();

    for (const allocation of allocations) {
      const intent = allocation.intent;

      if (
        !intent ||
        intent.status !== 'CONFIRMED' ||
        intent.amountBaseUnits !== allocation.amountBaseUnits
      ) {
        continue;
      }

      const latestLocalOutcome = intent.b25LocalBinding?.attempt?.outcomes[0];

      const confirmedLocal = intent.chainId === 31337 && latestLocalOutcome?.outcome === 'SUCCESS';

      const recordedHedera =
        intent.chainId === 296 &&
        assessB27HederaEvidence(
          {
            buyerAddress: allocation.buyerAddress,
            sellerAddress: allocation.sellerAddress,
            amountBaseUnits: allocation.amountBaseUnits,
          },
          intent,
          intent.evidence[0] ?? null,
        ) === 'RECORDED_CONSISTENT';

      if (!confirmedLocal && !recordedHedera) {
        continue;
      }

      const totals = confirmedLocal ? local : hederaRecorded;

      totals.confirmedTrades += 1;

      if (allocation.buyerId === userId) {
        totals.boughtWh += allocation.quantityWh;
        totals.spentBaseUnits += allocation.amountBaseUnits;
      } else {
        totals.soldWh += allocation.quantityWh;
        totals.earnedBaseUnits += allocation.amountBaseUnits;
      }
    }

    return {
      simulationOnly: true,
      user: {
        userId: user.id,
        name: user.name,
      },
      period: {
        from: start.toISOString(),
        to: end.toISOString(),
      },
      wallet: {
        status: user.wallet
          ? 'READY'
          : user.walletProvisioning
            ? user.walletProvisioning.state
            : 'NOT_PROVISIONED',
        hederaAccountId: user.wallet?.hederaAccountId ?? null,
        evmAddress: user.wallet?.evmAddress ?? null,
      },
      token: {
        symbol: 'TEUSD',
        decimals: 6,
        onChainBalanceBaseUnits: null,
        balanceStatus: 'NOT_VERIFIED',
      },
      confirmedTradingActivity: {
        localHardhat: serializeTotals(local),
        hederaTestnet: null,
      },
      recordedTradingActivity: {
        hederaTestnet: serializeTotals(hederaRecorded),
      },
      note: 'Trading activity is not a blockchain wallet balance.',
    };
  }
}
