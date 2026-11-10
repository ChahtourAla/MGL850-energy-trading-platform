import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { HederaContractsModule } from '../hedera-contracts/hedera-contracts.module.js';
import { TradingApiController } from './trading-api.controller.js';
import { TradingApiAdminController } from './trading-api-admin.controller.js';
import { TradingApiAdminGuard } from './trading-api-admin.guard.js';
import { TradingApiService } from './trading-api.service.js';
import { TradingApiJwtGuard } from './trading-api-jwt.guard.js';

@Module({
  imports: [ConfigModule, AuthModule, PrismaModule, HederaContractsModule],
  controllers: [TradingApiController, TradingApiAdminController],
  providers: [TradingApiService, TradingApiAdminGuard, TradingApiJwtGuard],
})
export class TradingApiModule {}
