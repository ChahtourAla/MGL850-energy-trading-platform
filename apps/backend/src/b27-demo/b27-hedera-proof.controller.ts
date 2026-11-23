import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';
import { verifyB27HederaTransfer } from './b27-hedera-proof.js';

@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27HederaProofController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  @Get('users/:userId/trades/:allocationId/verification')
  @Header('Cache-Control', 'no-store')
  async verification(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('allocationId') allocationId: string,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,66}$/.test(allocationId)) {
      throw new BadRequestException(
        'Invalid allocation identifier',
      );
    }

    const db = this.prisma.client;

    const user = await db.user.findFirst({
      where: {
        id: userId,
        accountOrigin: 'SIMULATED',
      },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Demo household not found');
    }

    const allocation = await db.v2Allocation.findFirst({
      where: {
        id: allocationId,
        OR: [
          { buyerId: userId },
          { sellerId: userId },
        ],
        status: 'VALIDATED',
        plan: { status: 'AUTHORITATIVE' },
        market: {
          namespace: 'hourly',
          mode: 'HOURLY',
        },
      },
      select: {
        id: true,
        marketId: true,
        quantityWh: true,
        unitPriceMicrousdPerKwh: true,
        buyerAddress: true,
        sellerAddress: true,
        amountBaseUnits: true,
        pricingVersion: true,
        remainder: true,
        intent: {
          select: {
            chainId: true,
            status: true,
            tokenAddress: true,
            contractAddress: true,
            amountBaseUnits: true,
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
                contractAddress: true,
                tokenAddress: true,
                buyerAddress: true,
                sellerAddress: true,
                amountBaseUnits: true,
                logIndex: true,
              },
            },
          },
        },
      },
    });

    if (!allocation) {
      throw new NotFoundException(
        'Authoritative allocation not found',
      );
    }

    const proof = await verifyB27HederaTransfer(
      {
        allocationId: allocation.id,
        marketId: allocation.marketId,
        quantityWh: allocation.quantityWh,
        unitPriceMicrousdPerKwh: allocation.unitPriceMicrousdPerKwh,
        buyerAddress: allocation.buyerAddress,
        sellerAddress: allocation.sellerAddress,
        amountBaseUnits: allocation.amountBaseUnits,
        pricingVersion: allocation.pricingVersion,
        remainder: allocation.remainder,
        intent: allocation.intent
          ? {
              ...allocation.intent,
              evidence:
                allocation.intent.evidence[0] ?? null,
            }
          : null,
      },
      {
        rpcUrl: process.env.HEDERA_JSON_RPC_URL,
        expectedSettlementAddress:
          process.env.B27_EXPECTED_SETTLEMENT_ADDRESS,
        expectedTokenAddress:
          process.env.B27_EXPECTED_TEUSD_ADDRESS ??
          process.env.TEST_ENERGY_USD_ADDRESS,
      },
    );

    return {
      allocationId: allocation.id,
      ...proof,
    };
  }
}
