import 'dotenv/config'

/**
 * Testy běží proti SAMOSTATNÉ databázi.
 *
 * Přesměrování se dělá tady, ještě před načtením src/lib/env.ts, který si
 * hodnoty přečte jen jednou při importu.
 */
function require_(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Chybí ${name}. Testy potřebují vlastní databázi – doplň TEST_* hodnoty do .env ` +
        'a spusť `npm run test:db`.',
    )
  }
  return value
}

process.env.DATABASE_URL = require_('TEST_DATABASE_URL')
process.env.APP_DATABASE_URL = require_('TEST_APP_DATABASE_URL')
process.env.RESOLVER_DATABASE_URL = require_('TEST_RESOLVER_DATABASE_URL')

if (!process.env.FILE_MASTER_KEY) process.env.FILE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
if (!process.env.SECRET_PEPPER) process.env.SECRET_PEPPER = Buffer.alloc(32, 9).toString('base64')
