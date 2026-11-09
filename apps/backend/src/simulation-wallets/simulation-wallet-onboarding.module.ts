import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { SimulationWalletAdminGuard } from './simulation-wallet-admin.guard.js';
import { SimulationWalletOnboardingController } from './simulation-wallet-onboarding.controller.js';
import { SimulationWalletOnboardingService } from './simulation-wallet-onboarding.service.js';

@Module({
  imports: [PrismaModule, WalletsModule],
  controllers: [SimulationWalletOnboardingController],
  providers: [SimulationWalletOnboardingService, SimulationWalletAdminGuard],
})
export class SimulationWalletOnboardingModule {}
