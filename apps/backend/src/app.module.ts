import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { environmentSchema } from './config/environment.schema.js';
import { HealthModule } from './health/health.module.js';

/**
 * Resolve paths relative to this file.
 *
 * Works in:
 * - src/app.module.ts during development
 * - dist/app.module.js after compilation
 *
 * Both locations have apps/backend/ as their parent.
 */
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      envFilePath: [resolve(backendRoot, '.env'), resolve(backendRoot, '../../.env')],

      validationSchema: environmentSchema,
    }),

    HealthModule,
  ],

  controllers: [AppController],

  providers: [AppService],
})
export class AppModule {}
