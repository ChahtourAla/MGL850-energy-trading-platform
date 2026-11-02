import { describe, expect, it } from 'vitest';

import type { ConfigService } from '@nestjs/config';

import { DatabaseService } from './database.service.js';

describe('DatabaseService', () => {
  it('reports not_configured when URL is absent', async () => {
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;

    const service = new DatabaseService(config);

    expect(await service.checkConnection()).toBe('not_configured');

    await service.onModuleDestroy();
  });

  it('reports unavailable when PostgreSQL cannot connect', async () => {
    const config = {
      get: (name: string) =>
        name === 'DATABASE_URL'
          ? 'postgresql://testuser:testpass@127.0.0.1:1/energy_trading'
          : undefined,
    } as unknown as ConfigService;

    const service = new DatabaseService(config);

    expect(await service.checkConnection()).toBe('unavailable');

    await service.onModuleDestroy();
  });
});
