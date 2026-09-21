import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '@/generated/prisma/client'
import type { Prisma } from '@/generated/prisma/client'
import { env } from './env'

/**
 * Přístup do databáze.
 *
 * Aplikace se připojuje dvěma různými rolemi a je to záměr, ne komplikace:
 *
 *  appClient      – běžný provoz. Nemá BYPASSRLS. Každý dotaz vidí jen řádky
 *                   té ordinace, jejíž id je nastavené v app.practice_id.
 *                   Když není nastavené, nevidí NIC – oddělení ordinací tedy
 *                   selhává směrem k prázdnému výsledku, ne k úniku dat.
 *
 *  resolverClient – jen překlad identity na ordinaci: session cookie → uživatel,
 *                   slug → ordinace, pacientský token → ordinace. Veřejné cesty
 *                   a přihlášení totiž ordinaci ještě neznají, teprve ji zjišťují.
 *                   Co smí, je dané granty v migraci, ne důvěrou v tenhle kód.
 *
 * Role vlastníka schématu (DATABASE_URL) se tu nepoužívá vůbec. Používá ji jen
 * Prisma CLI při migracích a seedu a v produkci ji aplikace ani nezná.
 */

declare global {
  // V development režimu Next.js modul opakovaně načítá; bez tohohle by se
  // při každém hot reloadu otevřel nový fond spojení.
  var __medpredaniApp: PrismaClient | undefined
  var __medpredaniResolver: PrismaClient | undefined
}

function createClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

export const appClient =
  globalThis.__medpredaniApp ?? createClient(env.APP_DATABASE_URL)

export const resolverClient =
  globalThis.__medpredaniResolver ?? createClient(env.RESOLVER_DATABASE_URL)

if (env.NODE_ENV !== 'production') {
  globalThis.__medpredaniApp = appClient
  globalThis.__medpredaniResolver = resolverClient
}

/** Klient uvnitř transakce s nastaveným kontextem ordinace. */
export type TenantClient = Prisma.TransactionClient

/**
 * Spustí práci v kontextu jedné ordinace.
 *
 * Kontext se nastavuje přes set_config(..., true), tedy platí jen do konce
 * transakce. Proto je každý tenantní požadavek jedna transakce – drží spojení
 * po dobu své práce. Při zdejším objemu provozu je to bezvýznamná cena za to,
 * že izolaci hlídá databáze a ne pozornost programátora.
 *
 * Náročné operace (slučování PDF, komunikace s úložištěm) patří MIMO tenhle
 * blok – transakce má být krátká.
 */
export async function withPractice<T>(
  practiceId: string,
  work: (db: TenantClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return appClient.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`
      return work(tx)
    },
    {
      maxWait: 5_000,
      timeout: options?.timeoutMs ?? 15_000,
    },
  )
}

/**
 * Kontrola, že kontext ordinace opravdu platí. Používá se v testech – ověřuje,
 * že se aplikace nespoléhá jen na filtry v dotazech.
 */
export async function currentPracticeId(db: TenantClient): Promise<string | null> {
  const rows = await db.$queryRaw<{ practice_id: string | null }[]>`
    SELECT app_practice_id()::text AS practice_id
  `
  return rows[0]?.practice_id ?? null
}
