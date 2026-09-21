import 'dotenv/config'

import { spawnSync } from 'node:child_process'

/**
 * Přehraje migrace do testovací databáze.
 *
 * Prisma CLI čte DATABASE_URL, proto se sem na chvíli podstrčí TEST_DATABASE_URL.
 */
const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) {
  console.error('Chybí TEST_DATABASE_URL v .env')
  process.exit(1)
}

if (testUrl === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL a DATABASE_URL ukazují na stejnou databázi. To by testy smazaly vývojová data.')
  process.exit(1)
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
})

process.exit(result.status ?? 1)
