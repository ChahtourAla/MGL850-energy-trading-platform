import { describe, expect, it } from 'vitest';

import { environmentSchema } from '../src/config/environment.schema.js';

describe('Environment validation', () => {
  it('provides safe defaults', () => {
    const config = environmentSchema.parse({});

    expect(config.NODE_ENV).toBe('development');
    expect(config.BACKEND_PORT).toBe(3001);
    expect(config.CORS_ORIGINS).toBe('http://localhost:3000');
  });

  it('accepts valid environment values', () => {
    const config = environmentSchema.parse({
      NODE_ENV: 'test',
      BACKEND_PORT: '4000',
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
      SWAGGER_ENABLED: 'false',
    });

    expect(config.BACKEND_PORT).toBe(4000);
    expect(config.SWAGGER_ENABLED).toBe('false');
  });

  it.each(['abc', '0', '-1', '65536', '3001.5'])('rejects invalid port %s', (port) => {
    const result = environmentSchema.safeParse({
      BACKEND_PORT: port,
    });

    expect(result.success).toBe(false);
  });

  it('rejects wildcard CORS', () => {
    const result = environmentSchema.safeParse({
      CORS_ORIGINS: '*',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid CORS origins', () => {
    const result = environmentSchema.safeParse({
      CORS_ORIGINS: 'not-an-origin',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid environment name', () => {
    const result = environmentSchema.safeParse({
      NODE_ENV: 'invalid-environment',
    });

    expect(result.success).toBe(false);
  });
});
