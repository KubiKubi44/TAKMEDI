import 'server-only'

import { cookies } from 'next/headers'

import type { Role, UserStatus } from '@/generated/prisma/enums'
import { generateSessionToken, hashToken } from './crypto'
import { resolverClient } from './db'
import { env } from './env'
import type { RequestInfo } from './request-context'

/**
 * Přihlašovací relace.
 *
 * Relace je řádek v databázi, ne podepsaný token v cookie. Je to o jeden dotaz
 * dražší, ale dává dvě věci, které se s JWT dělají špatně: okamžité odhlášení
 * (stačí zneplatnit řádek) a skutečnou expiraci při nečinnosti.
 *
 * S tabulkou session pracuje výhradně rozlišovací role – aplikační role na ni
 * nemá žádná práva, takže se k cizím přihlášením nedostane ani při chybě.
 */

export const SESSION_COOKIE = 'medpredani_session'

/** Tvrdý strop bez ohledu na aktivitu. Po 12 hodinách se přihlašuje znovu. */
const ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000

/**
 * Jak často se posouvá klouzavá expirace. Bez téhle brzdy by každé otevření
 * stránky znamenalo zápis do databáze.
 */
const TOUCH_THROTTLE_MS = 60 * 1000

export type SessionUser = {
  id: string
  practiceId: string
  email: string
  name: string
  roles: Role[]
  status: UserStatus
  totpConfirmed: boolean
}

export type SessionPractice = {
  id: string
  name: string
  slug: string
  sessionIdleMinutes: number
}

export type ActiveSession = {
  id: string
  userId: string
  /** Druhý faktor už proběhl. Bez toho se uživatel nedostane dál než na jeho zadání. */
  totpVerified: boolean
  lastSeenAt: Date
  user: SessionUser
  practice: SessionPractice
}

// ---------------------------------------------------------------------------
// Životní cyklus relace
// ---------------------------------------------------------------------------

/**
 * Založí relaci po ověření hesla. Druhý faktor v tu chvíli ještě neproběhl,
 * takže relace zatím neotevírá nic než obrazovku pro zadání kódu.
 */
export async function createSession(params: {
  userId: string
  idleMinutes: number
  context: RequestInfo
}): Promise<{ token: string; absoluteExpiresAt: Date }> {
  const token = generateSessionToken()
  const now = Date.now()
  const absoluteExpiresAt = new Date(now + ABSOLUTE_LIFETIME_MS)

  await resolverClient.session.create({
    data: {
      userId: params.userId,
      tokenHash: hashToken(token),
      idleExpiresAt: new Date(now + params.idleMinutes * 60 * 1000),
      absoluteExpiresAt,
      ip: params.context.ip,
      userAgent: params.context.userAgent,
    },
  })

  return { token, absoluteExpiresAt }
}

/**
 * Dohledá platnou relaci podle tokenu z cookie.
 *
 * Vrací null pro cokoli neplatného – vypršelou, zneplatněnou i neexistující
 * relaci, a stejně tak pro zablokovaný účet. Volající se nikdy nedozví, který
 * z těch důvodů to byl.
 */
export async function findActiveSession(token: string): Promise<ActiveSession | null> {
  const row = await resolverClient.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      totpVerifiedAt: true,
      revokedAt: true,
      idleExpiresAt: true,
      absoluteExpiresAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          practiceId: true,
          email: true,
          name: true,
          roles: true,
          status: true,
          totpConfirmedAt: true,
          practice: {
            select: { id: true, name: true, slug: true, sessionIdleMinutes: true },
          },
        },
      },
    },
  })

  if (!row) return null

  const now = new Date()
  if (row.revokedAt) return null
  if (row.idleExpiresAt <= now) return null
  if (row.absoluteExpiresAt <= now) return null
  if (row.user.status !== 'ACTIVE') return null

  return {
    id: row.id,
    userId: row.userId,
    totpVerified: row.totpVerifiedAt !== null,
    lastSeenAt: row.lastSeenAt,
    practice: row.user.practice,
    user: {
      id: row.user.id,
      practiceId: row.user.practiceId,
      email: row.user.email,
      name: row.user.name,
      roles: row.user.roles,
      status: row.user.status,
      totpConfirmed: row.user.totpConfirmedAt !== null,
    },
  }
}

/**
 * Posune klouzavou expiraci.
 *
 * Zapisuje se JEN do databáze, cookie se nemění. Next.js totiž dovoluje zápis
 * cookie výhradně v Server Action, Route Handleru a v proxy – při vykreslování
 * stránky, kde se relace nejčastěji kontroluje, by to skončilo chybou za běhu.
 * Cookie proto nese jen tvrdý strop a autoritou pro vypršení při nečinnosti je
 * řádek v databázi. Vedlejší přínos: odhlášení se projeví okamžitě.
 */
export async function touchSession(params: {
  sessionId: string
  lastSeenAt: Date
  idleMinutes: number
}): Promise<void> {
  if (Date.now() - params.lastSeenAt.getTime() < TOUCH_THROTTLE_MS) return

  const now = new Date()
  await resolverClient.session.updateMany({
    where: { id: params.sessionId, revokedAt: null },
    data: {
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + params.idleMinutes * 60 * 1000),
    },
  })
}

/**
 * Potvrdí druhý faktor a ZÁROVEŇ vymění token relace.
 *
 * Výměna je tu schválně: relace vzniká už po zadání hesla, takže kdyby token
 * zůstal stejný, hodnota získaná před ověřením druhého faktoru by po něm
 * najednou platila naplno. To je klasická session fixation. Nový token nese
 * stejný řádek, takže se nic neztrácí.
 */
export async function confirmTotpAndRotate(sessionId: string): Promise<string> {
  const token = generateSessionToken()

  await resolverClient.session.update({
    where: { id: sessionId },
    data: {
      tokenHash: hashToken(token),
      totpVerifiedAt: new Date(),
      lastSeenAt: new Date(),
    },
  })

  return token
}

export async function revokeSession(sessionId: string): Promise<void> {
  await resolverClient.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Odhlásí uživatele ze všech zařízení – po změně hesla nebo při zablokování. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await resolverClient.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/** Úklid relací, které už dávno vypršely. Volá ho denní úloha. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await resolverClient.session.deleteMany({
    where: { absoluteExpiresAt: { lt: new Date() } },
  })
  return result.count
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------
//
// POZOR: následující tři funkce zapisují cookie, což Next.js dovoluje pouze
// v Server Action, v Route Handleru a v proxy. Zavolat je při vykreslování
// stránky skončí chybou za běhu, kterou typová kontrola neodhalí.

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

/** Čtení cookie je naopak povolené kdekoli. */
export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies()
  return store.get(SESSION_COOKIE)?.value ?? null
}
