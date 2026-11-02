import { z } from 'zod';

/**
 * Validate one or more comma-separated HTTP(S) origins.
 *
 * Examples:
 * http://localhost:3000
 * http://localhost:3000,http://localhost:5173
 *
 * Wildcard "*" is intentionally not accepted.
 */
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
 * B02 environment schema.
 *
 * passthrough() preserves additional variables in the
 * existing root .env file, such as DATABASE_URL, which
 * will be validated by later modules.
 */
export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    CORS_ORIGINS: z.string().default('http://localhost:3000').refine(isValidOriginList, {
      message: 'CORS_ORIGINS must contain valid HTTP(S) origins',
    }),

    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
  })
  .passthrough();

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
