import { z } from 'zod';

function isValidOriginList(value: string): boolean {
  const origins = value.split(',').map((origin) => origin.trim());

  if (origins.length === 0) {
    return false;
  }

  return origins.every((origin) => {
    if (!origin) {
      return false;
    }

    try {
      const url = new URL(origin);

      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.origin === origin &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
}

/**
 * Check PostgreSQL URL syntax.
 *
 * Credentials must be present.
 * This does not verify that PostgreSQL is reachable.
 */
function isValidPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === 'postgresql:' || url.protocol === 'postgres:') &&
      Boolean(url.hostname) &&
      Boolean(url.username) &&
      Boolean(url.password) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    CORS_ORIGINS: z.string().default('http://localhost:3000').refine(isValidOriginList, {
      message: 'CORS_ORIGINS must contain valid HTTP(S) origins',
    }),

    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),

    DATABASE_URL: z
      .string()
      .refine(isValidPostgresUrl, {
        message: 'DATABASE_URL must be a valid PostgreSQL connection URL',
      })
      .optional(),

    JWT_ACCESS_SECRET: z.string().min(32).optional(),
  })
  .passthrough();

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
