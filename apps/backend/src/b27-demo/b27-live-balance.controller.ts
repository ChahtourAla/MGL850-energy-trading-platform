import {
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
import { readB27LiveTokenBalance } from './b27-live-token-balance.js';

/** A separate guarded endpoint: existing B27 wallet/trading totals are unchanged. */
@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27LiveBalanceController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('users/:userId/token-balance')
  @Header('Cache-Control', 'no-store')
  async getTokenBalance(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, accountOrigin: 'SIMULATED' },
      select: {
        id: true,
        name: true,
        wallet: { select: { evmAddress: true, hederaAccountId: true } },
      },
    });

    if (!user) throw new NotFoundException('Demo household not found');

    const balance = await readB27LiveTokenBalance(user.wallet?.evmAddress ?? null, {
      rpcUrl: process.env.HEDERA_JSON_RPC_URL,
      expectedTokenAddress: process.env.B27_EXPECTED_TEUSD_ADDRESS,
    });

    return {
      simulationOnly: true,
      readOnly: true,
      user: { userId: user.id, name: user.name },
      wallet: {
        hederaAccountId: user.wallet?.hederaAccountId ?? null,
        evmAddress: user.wallet?.evmAddress ?? null,
      },
      token: { symbol: 'TEUSD', decimals: 6, ...balance },
      note: 'Live token balance is not evidence that an energy settlement occurred.',
    };
  }
}
