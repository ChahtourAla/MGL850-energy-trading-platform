import 'reflect-metadata';

import { ConsoleLogger, Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { setupApp } from './app.setup.js';

async function bootstrap(): Promise<void> {
  // NestJS framework logs as structured JSON.
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
    }),
  });

  // Configure HTTP security, CORS, validation,
  // errors, logging, and Swagger.
  setupApp(app);

  const config = app.get(ConfigService);

  const port = Number(config.getOrThrow<number>('BACKEND_PORT'));

  await app.listen(port);

  const logger = new Logger('Bootstrap');

  logger.log({
    event: 'server_started',
    service: 'p2p-energy-backend',
    port,
  });
}

bootstrap().catch((error: unknown) => {
  console.error(
    'Failed to start the MGL850 backend:',
    error instanceof Error ? error.message : 'Unknown startup error',
  );

  process.exitCode = 1;
});
