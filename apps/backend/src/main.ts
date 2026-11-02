import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/**
 * Bootstrap the MGL850 backend application.
 *
 * B01:
 * - Start the NestJS HTTP server.
 * - Use BACKEND_PORT when provided.
 * - Default to port 3001.
 *
 * Full environment validation will be added in B02.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const rawPort = process.env.BACKEND_PORT ?? '3001';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('BACKEND_PORT must be an integer between 1 and 65535');
  }

  await app.listen(port);

  console.log(`MGL850 Backend is running at http://localhost:${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start MGL850 Backend:', error);
  process.exitCode = 1;
});
