import { B27HederaProofController } from './b27-hedera-proof.controller.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';

import { B27DemoController } from './b27-demo.controller.js';
import { B27TradingHistoryController } from './b27-trading-history.controller.js';
import { B27WalletController } from './b27-wallet.controller.js';
import { B27MatchingController } from './b27-matching.controller.js';
import { B27LifecycleController } from './b27-lifecycle.controller.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [B27HederaProofController,
    B27DemoController,
    B27TradingHistoryController,
    B27WalletController,
    B27MatchingController,
    B27LifecycleController,
  ],
  providers: [TradingApiAdminGuard],
})
export class B27DemoModule {}
