import 'server-only'

import { cache } from 'react'
import { forbidden, redirect } from 'next/navigation'

import type { Role } from '@/generated/prisma/enums'
import {
  findActiveSession,
  readSessionCookie,
  touchSession,
  type ActiveSession,
  type SessionUser,
} from './session'

/**
 * Přístupová vrstva (DAL).
 *
 * Jediné místo, kde se v aplikaci zjišťuje, kdo je přihlášený. Každá chráněná
 * stránka i každá Server Action začíná voláním některé z funkcí odsud.
 *
 * Kontrola ZÁMĚRNĚ nesedí v layoutu. Layout se při navigaci mezi stránkami
 * znovu nevykresluje a hlavně nerozhoduje o tom, jestli se zbytek cesty
 * vykreslí – segmenty a paralelní sloty renderuje router nezávisle na něm.
 * Layout, který něco schová, tedy nezabrání tomu, aby se to spočítalo a
 * objevilo se to v RSC payloadu. Bezpečnostní hranice je stránka a tahle vrstva.
 */

/**
 * Relace pro aktuální požadavek.
 *
 * cache() z Reactu zajistí, že se při jednom vykreslení dotaz provede jednou,
 * i když si o relaci řekne stránka, několik komponent a ještě DAL.
 */
export const getSession = cache(async (): Promise<ActiveSession | null> => {
  const token = await readSessionCookie()
  if (!token) return null

  const session = await findActiveSession(token)
  if (!session) return null

  // Posun klouzavé expirace. Zapisuje se jen do databáze – cookie se při
  // vykreslování stránky měnit nesmí. Viz komentář u touchSession().
  await touchSession({
    sessionId: session.id,
    lastSeenAt: session.lastSeenAt,
    idleMinutes: session.practice.sessionIdleMinutes,
  })

  return session
})

/**
 * Plně přihlášený uživatel. Kdo tuhle funkci projde, má za sebou heslo
 * i druhý faktor.
 *
 * Když něco chybí, přesměruje tam, kde se to doplní. redirect() uvnitř
 * vyhazuje zvláštní výjimku, kterou Next zpracuje sám – nesmí se odchytit
 * blokem try/catch okolo volání.
 */
export async function requireUser(): Promise<ActiveSession> {
  const session = await getSession()

  if (!session) redirect('/prihlaseni')

  // Dvoufázové přihlášení je povinné. Kdo si ho ještě nenastavil, se nikam
  // jinam než na jeho nastavení nedostane.
  if (!session.user.totpConfirmed) redirect('/prihlaseni/nastaveni-2fa')
  if (!session.totpVerified) redirect('/prihlaseni/overeni')

  return session
}

/**
 * Totéž pro cesty pod /api, které se volají přes fetch.
 *
 * requireUser() se tam nehodí: přesměrovává na přihlašovací stránku, takže by
 * volající dostal HTML se stavem 200 místo srozumitelné odpovědi. Vrací se
 * proto null a obsluha si zvolí vlastní stavový kód.
 */
export async function getApiUser(): Promise<ActiveSession | null> {
  const session = await getSession()
  if (!session) return null
  if (!session.user.totpConfirmed || !session.totpVerified) return null
  return session
}

/** Relace ve stavu „heslo zadané, druhý faktor zatím ne". Pro obrazovky 2FA. */
export async function requireHalfSession(): Promise<ActiveSession> {
  const session = await getSession()
  if (!session) redirect('/prihlaseni')
  return session
}

export function hasRole(user: SessionUser, ...roles: Role[]): boolean {
  return roles.some((role) => user.roles.includes(role))
}

/** Uživatel spravuje ordinaci: uživatele, NFC čip, nastavení. */
export function isPracticeAdmin(user: SessionUser): boolean {
  return hasRole(user, 'PRACTICE_ADMIN')
}

/** Uživatel smí do knihovny šablon. Sestra ne. */
export function canManageLibrary(user: SessionUser): boolean {
  return hasRole(user, 'DOCTOR', 'PRACTICE_ADMIN')
}

/**
 * Nastavení druhého faktoru se smí týkat JEN účtu, který ho ještě nemá.
 *
 * Bez téhle kontroly by stačilo znát heslo: útočník by se dostal k relaci
 * po prvním faktoru, zaregistroval si vlastní tajemství a druhý faktor oběti
 * by tím obešel.
 *
 * Třída bydlí tady, a ne u přihlašovacích akcí, z technického důvodu: soubor
 * označený 'use server' smí exportovat VÝHRADNĚ asynchronní funkce. Export
 * třídy z něj udělá modul bez jediného exportu a build spadne – typová
 * kontrola to přitom nepozná.
 */
export class TotpAlreadySetError extends Error {
  constructor() {
    super('Druhý faktor je už nastavený.')
    this.name = 'TotpAlreadySetError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'K této části nemáte oprávnění.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/**
 * Přihlášený uživatel s alespoň jednou z uvedených rolí. Pro STRÁNKY.
 *
 * Chybějící oprávnění není přesměrování – uživatel je přihlášený správně, jen
 * sem nepatří, a mlčenlivé odsunutí jinam by ho jen mátlo. forbidden() vrátí
 * stav 403 a vykreslí src/app/forbidden.tsx na serveru, takže hláška dorazí
 * i bez JavaScriptu.
 *
 * V Server Actions se forbidden() nepoužívá – tam se vyhazuje ForbiddenError,
 * protože akce nevykresluje stránku, ale vrací stav do formuláře.
 */
export async function requireRole(...roles: Role[]): Promise<ActiveSession> {
  const session = await requireUser()
  if (!hasRole(session.user, ...roles)) forbidden()
  return session
}

/**
 * Tvar uživatele určený k odeslání do prohlížeče.
 *
 * Hash hesla ani tajemství druhého faktoru se do klientské komponenty nesmí
 * dostat – a co se pošle do RSC payloadu, to je v prohlížeči čitelné, i když
 * se to nikde nevykreslí. Funkce vypisuje pole výslovně, takže přidání
 * citlivého sloupce do modelu ho sem samo nepropašuje.
 */
export type UserDto = {
  id: string
  name: string
  email: string
  roles: Role[]
}

export function toUserDto(user: SessionUser): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
  }
}
