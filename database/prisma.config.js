import path from 'path';
import dotenv from 'dotenv';
// Charge le .env situé à la racine du monorépertoire (un cran au-dessus de database/)
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { defineConfig, env } from 'prisma/config';
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
        seed: 'tsx prisma/seed.ts',
    },
    datasource: {
        url: env('DATABASE_URL'),
    },
});
