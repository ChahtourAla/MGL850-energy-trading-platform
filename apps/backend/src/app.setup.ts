import { ValidationPipe, type INestApplication } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import helmet from 'helmet';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';

/**
 * Apply shared HTTP configuration.
 *
 * Used by the real server and API integration tests.
 */
export function setupApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  // ---------------------------------------------
  // 1. HTTP security headers
  // ---------------------------------------------

  app.use(helmet());

  // ---------------------------------------------
  // 2. Request IDs and logging
  // ---------------------------------------------

  app.use(requestIdMiddleware);

  // ---------------------------------------------
  // 3. CORS configuration
  // ---------------------------------------------

  const corsOrigins = config
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim());

  app.enableCors({
    origin: corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  });

  // ---------------------------------------------
  // 4. Global request validation
  // ---------------------------------------------

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,

      transformOptions: {
        enableImplicitConversion: false,
      },

      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  // ---------------------------------------------
  // 5. Centralized error handling
  // ---------------------------------------------

  app.useGlobalFilters(new AllExceptionsFilter());

  // ---------------------------------------------
  // 6. Swagger / OpenAPI
  // ---------------------------------------------

  const nodeEnv = config.get<string>('NODE_ENV', 'development');

  const explicitSwaggerSetting = config.get<string>('SWAGGER_ENABLED');

  // Development/test: enabled by default.
  // Production: disabled unless explicitly enabled.
  const swaggerEnabled =
    explicitSwaggerSetting === undefined
      ? nodeEnv !== 'production'
      : explicitSwaggerSetting === 'true';

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('MGL850 P2P Energy Trading API')
      .setDescription('REST API for decentralized P2P electricity trading')
      .setVersion('0.1.0')
      .build();

    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, swaggerConfig), {
      jsonDocumentUrl: 'docs-json',
    });
  }
}
