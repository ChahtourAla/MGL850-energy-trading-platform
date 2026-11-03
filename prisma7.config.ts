import 'dotenv/config';

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'database/schema.prisma',

  migrations: {
    path: 'database/migrations',
  },

  datasource: {
    url: env('DATABASE_URL'),
  },
});
