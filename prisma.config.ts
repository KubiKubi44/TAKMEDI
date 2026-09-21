import 'dotenv/config'

import path from 'node:path'
import { defineConfig, env } from '@prisma/config'

/**
 * Konfigurace Prisma CLI (migrace, generování, seed).
 *
 * Používá se tu DATABASE_URL, tedy role vlastníka schématu. Aplikace za běhu
 * se připojuje jinými rolemi (APP_DATABASE_URL, RESOLVER_DATABASE_URL), které
 * nemají práva na DDL a podléhají row-level security – viz src/lib/db.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
})
