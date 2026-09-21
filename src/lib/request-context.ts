import 'server-only'

import { headers } from 'next/headers'

import { env } from './env'

/**
 * Informace o požadavku: IP adresa, prohlížeč a ochrana proti CSRF.
 *
 * Tenhle modul existuje kvůli dvěma věcem, které Next.js 16 NEŘEŠÍ za nás,
 * ačkoli se to dá snadno předpokládat.
 */

// ---------------------------------------------------------------------------
// IP adresa klienta
// ---------------------------------------------------------------------------

/**
 * Next.js 16 žádné API pro IP adresu nemá – `NextRequest.ip` bylo odstraněno
 * ve verzi 15 a nic ho nenahradilo. Jediným zdrojem je hlavička
 * x-forwarded-for, a ta se musí číst obezřetně:
 *
 * Next hlavičku DOPLNÍ adresou ze socketu jen tehdy, když úplně chybí. Když si
 * ji klient pošle sám, Next ji nechá být a skutečnou adresu NIKAM nepřipojí –
 * je z požadavku nenávratně pryč. Bez reverzní proxy je tedy hodnota plně pod
 * kontrolou útočníka a jako podklad pro omezování četnosti by byla k ničemu.
 *
 * Proto se čte zprava: nejpravější položku přidala nejbližší vlastní proxy a
 * je důvěryhodná. Každá další doleva je důvěryhodná jen potud, pokud ji přidala
 * další vlastní proxy – odtud TRUSTED_PROXY_HOPS.
 *
 * DŮLEŽITÉ PŘI NASAZENÍ: proxy musí x-forwarded-for PŘEPISOVAT, ne přidávat
 * k hodnotě od klienta. Často doporučované nginx `proxy_add_x_forwarded_for`
 * klientovu hodnotu zachová, a je tedy pro tenhle účel nevhodné.
 */
export async function getClientIp(): Promise<string | null> {
  const forwarded = (await headers()).get('x-forwarded-for')
  if (!forwarded) return null

  // Node slučuje opakované hlavičky do jednoho řetězce odděleného čárkami,
  // takže se dělení čárkou postará i o případ, kdy je útočník pošle vícekrát.
  const hops = forwarded
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (hops.length === 0) return null

  if (env.TRUSTED_PROXY_HOPS === 0) {
    // Bez proxy před aplikací se nedá rozlišit skutečná adresa od podvržené.
    // Ve vývoji na tom nezáleží – útočník tam není a IP se hodí vidět.
    return env.NODE_ENV === 'development' ? (hops.at(-1) ?? null) : null
  }

  return hops[hops.length - env.TRUSTED_PROXY_HOPS] ?? null
}

export async function getUserAgent(): Promise<string | null> {
  const value = (await headers()).get('user-agent')
  if (!value) return null
  // Sloupec v databázi má 500 znaků; delší hlavička je stejně jen šum.
  return value.slice(0, 500)
}

export type RequestInfo = {
  ip: string | null
  userAgent: string | null
}

export async function getRequestContext(): Promise<RequestInfo> {
  const [ip, userAgent] = await Promise.all([getClientIp(), getUserAgent()])
  return { ip, userAgent }
}

/**
 * Totéž, ale snese i volání mimo obsluhu požadavku.
 *
 * headers() je Request-time API a mimo požadavek vyhodí výjimku. Úklidová
 * úloha nebo test ale žádný požadavek nemají a kvůli chybějící IP adrese
 * v auditu se rozhodně nemá shodit zápis samotné události.
 */
export async function tryGetRequestContext(): Promise<RequestInfo> {
  try {
    return await getRequestContext()
  } catch {
    return { ip: null, userAgent: null }
  }
}

// ---------------------------------------------------------------------------
// Ochrana proti CSRF
// ---------------------------------------------------------------------------

export class CrossOriginError extends Error {
  constructor() {
    super('Požadavek přišel z cizího původu.')
    this.name = 'CrossOriginError'
  }
}

/**
 * Vlastní kontrola původu požadavku.
 *
 * Next.js sice u Server Actions porovnává hlavičku Origin proti hostiteli, ale
 * když hlavička ÚPLNĚ CHYBÍ, požadavek propustí – v kódu je to ošetřené jen
 * varováním, a to se u fetch akcí navíc vůbec nezaloguje. Ručně sestavený
 * požadavek bez Origin tedy vestavěnou ochranou projde.
 *
 * Druhý problém: Next porovnává proti hlavičce x-forwarded-host, která má
 * přednost před host a nijak se neověřuje. Pokud ji proxy nepřepisuje, útočník
 * si ji nastaví sám a shoda Origin ↔ Host se dá předstírat.
 *
 * Tahle funkce proto obojí obchází: chybějící Origin ODMÍTÁ a porovnává proti
 * APP_URL z konfigurace, na kterou klient nedosáhne.
 *
 * Volá se na začátku každé Server Action, která něco mění.
 */
export async function requireTrustedOrigin(): Promise<void> {
  const h = await headers()

  // Sec-Fetch-Site posílají všechny současné prohlížeče a útočník ji podvrhnout
  // nemůže – je na seznamu zakázaných hlaviček pro skripty.
  const fetchSite = h.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new CrossOriginError()
  }

  const origin = h.get('origin')
  if (!origin) {
    // Tady se lišíme od Next.js, a to záměrně.
    throw new CrossOriginError()
  }

  let originHost: string
  let expectedHost: string
  try {
    originHost = new URL(origin).host
    expectedHost = new URL(env.APP_URL).host
  } catch {
    throw new CrossOriginError()
  }

  if (originHost.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new CrossOriginError()
  }
}
