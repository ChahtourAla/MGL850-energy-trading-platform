import request from 'supertest';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { INestApplication } from '@nestjs/common';

import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';

import { DatabaseService, type DatabaseStatus } from '../src/database/database.service.js';

describe('B03 Database Health API', () => {
  let app: INestApplication;

  let databaseStatus: DatabaseStatus = 'connected';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({
        checkConnection: async () => databaseStatus,
      })
      .compile();

    app = moduleRef.createNestApplication();

    setupApp(app);

    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns HTTP 200 when the database is connected', async () => {
    databaseStatus = 'connected';

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body.status).toBe('ok');

    expect(response.body.dependencies.database).toBe('connected');
  });

  it('returns HTTP 503 when the database is unavailable', async () => {
    databaseStatus = 'unavailable';

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body.statusCode).toBe(503);
    expect(response.body.error).toBe('HTTP_503');
    expect(response.body.message).toBe('PostgreSQL is not ready');
  });

  it('returns HTTP 503 when the database is not configured', async () => {
    databaseStatus = 'not_configured';

    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  it('keeps HTTP liveness available when the database is down', async () => {
    databaseStatus = 'unavailable';

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('ok');

    expect(response.body.dependencies.database).toBe('unavailable');
  });
});
