import { describe, expect, it } from 'vitest';

import { environmentSchema } from '../src/config/environment.schema.js';

describe('B03 database configuration', () => {
  it('accepts a valid PostgreSQL URL', () => {
    const result = environmentSchema.safeParse({
      DATABASE_URL: 'postgresql://testuser:testpass@127.0.0.1:5432/energy_trading',
    });

    expect(result.success).toBe(true);
  });

  it.each([
    'not-a-url',
    'http://user:pass@localhost:5432/database',
    'postgresql://localhost:5432/database',
    'postgresql://user@localhost:5432/database',
    'postgresql://user:pass@localhost:5432',
  ])('rejects invalid database URL %s', (url) => {
    const result = environmentSchema.safeParse({
      DATABASE_URL: url,
    });

    expect(result.success).toBe(false);
  });
});
