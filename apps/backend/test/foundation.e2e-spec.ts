import 'reflect-metadata';

import request from 'supertest';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Body, Controller, Get, Post, type INestApplication } from '@nestjs/common';

import { Test } from '@nestjs/testing';

import { IsNotEmpty, IsString } from 'class-validator';

import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';

/**
 * Test-only DTO.
 *
 * Decorators are applied programmatically to
 * avoid Vitest/Rolldown parameter-decorator
 * transformation limitations.
 */
class ValidationProbeDto {
  name!: string;
}

IsString()(ValidationProbeDto.prototype, 'name');

IsNotEmpty()(ValidationProbeDto.prototype, 'name');

/**
 * Test-only controller.
 *
 * This controller is never registered in the
 * production AppModule.
 */
class ProbeController {
  validate(input: ValidationProbeDto): ValidationProbeDto {
    return input;
  }

  explode(): never {
    throw new Error('PRIVATE_INTERNAL_MARKER');
  }
}

/**
 * Register the validation route without using
 * decorator syntax in this test file.
 */
const validationDescriptor = Object.getOwnPropertyDescriptor(ProbeController.prototype, 'validate');

if (!validationDescriptor) {
  throw new Error('Validation probe descriptor not found');
}

Post('validate')(ProbeController.prototype, 'validate', validationDescriptor);

Body()(ProbeController.prototype, 'validate', 0);

/**
 * Provide runtime DTO type metadata.
 *
 * NestJS ValidationPipe uses this metadata
 * to transform and validate the request body.
 */
Reflect.defineMetadata(
  'design:paramtypes',
  [ValidationProbeDto],
  ProbeController.prototype,
  'validate',
);

/**
 * Register the error testing route.
 */
const errorDescriptor = Object.getOwnPropertyDescriptor(ProbeController.prototype, 'explode');

if (!errorDescriptor) {
  throw new Error('Error probe descriptor not found');
}

Get('explode')(ProbeController.prototype, 'explode', errorDescriptor);

/**
 * Register the controller's route prefix.
 */
Controller('__probe')(ProbeController);

/**
 * B02 HTTP integration tests.
 */
describe('B02 API Foundation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();

    setupApp(app);

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('preserves GET / from B01', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body.service).toBe('p2p-energy-backend');
  });

  it('GET /health reports backend liveness', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.service).toBe('p2p-energy-backend');

    expect(response.body.status).toBe('ok');

    expect(response.body.dependencies).toEqual({
      database: 'not_configured',
      blockchain: 'not_configured',
    });

    expect(response.body.timestamp).toBeDefined();
  });

  it('creates a server-generated request ID', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-ID', 'untrusted-client-value')
      .expect(200);

    const requestId = response.headers['x-request-id'] as string;

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(requestId).not.toBe('untrusted-client-value');
  });

  it('returns a structured 404 error', async () => {
    const response = await request(app.getHttpServer())
      .get('/unknown-route?private=hidden')
      .expect(404);

    expect(response.body.statusCode).toBe(404);
    expect(response.body.error).toBe('HTTP_404');

    expect(response.body.path).toBe('/unknown-route');

    expect(response.body.requestId).toBe(response.headers['x-request-id']);

    expect(response.body.timestamp).toBeDefined();
  });

  it('accepts a valid DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/__probe/validate')
      .send({
        name: 'Household A',
      })
      .expect(201);

    expect(response.body).toEqual({
      name: 'Household A',
    });
  });

  it('rejects an invalid DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/__probe/validate')
      .send({
        name: 42,
      })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('rejects unknown DTO fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/__probe/validate')
      .send({
        name: 'Household A',
        unauthorizedField: true,
      })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('hides unexpected internal errors', async () => {
    const response = await request(app.getHttpServer()).get('/__probe/explode').expect(500);

    expect(response.body.error).toBe('INTERNAL_SERVER_ERROR');

    expect(response.body.message).toBe('Internal server error');

    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_INTERNAL_MARKER');
  });

  it('allows the configured CORS origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:3000')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('does not allow an unconfigured CORS origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://untrusted.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves OpenAPI JSON', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(response.body.openapi).toBeDefined();

    expect(response.body.paths['/health']).toBeDefined();
  });
});
