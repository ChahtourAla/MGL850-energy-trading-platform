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

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      envFilePath: [resolve(backendRoot, '.env'), resolve(backendRoot, '../../.env')],

      validationSchema: environmentSchema,
    }),

    HealthModule,
    PrismaModule,
    ContractsModule,
  ],

  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
