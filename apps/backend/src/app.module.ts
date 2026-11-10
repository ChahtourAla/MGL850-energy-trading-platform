import { TradingApiModule } from './trading-api/trading-api.module.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { environmentSchema } from './config/environment.schema.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

import { ContractsModule } from './contracts/contracts.module.js';

import { AuthModule } from './auth/auth.module.js';
import { RegistryImportModule } from './registry-import/registry-import.module.js';
import { EnergyImportModule } from './energy-import/energy-import.module.js';
import { SimulationWalletOnboardingModule } from './simulation-wallets/simulation-wallet-onboarding.module.js';
import { HederaContractsModule } from './hedera-contracts/hedera-contracts.module.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

@Module({
  imports: [
    TradingApiModule,
    ConfigModule.forRoot({
      isGlobal: true,

      envFilePath: [resolve(backendRoot, '.env'), resolve(backendRoot, '../../.env')],

      validationSchema: environmentSchema,
    }),

    HealthModule,
    PrismaModule,
    ContractsModule,
    AuthModule,
    RegistryImportModule,
    EnergyImportModule,
    SimulationWalletOnboardingModule,
    HederaContractsModule,
  ],

  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
