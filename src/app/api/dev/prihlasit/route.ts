import { redirect } from 'next/navigation'

import { hashToken } from '@/lib/crypto'
import { resolverClient, withPractice } from '@/lib/db'
import { env } from '@/lib/env'
import { notFoundResponse } from '@/lib/http'
import { getRequestContext } from '@/lib/request-context'
import { createSession, setSessionCookie } from '@/lib/session'

/**
 * Vývojová zkratka přihlášení.
 *
 * Vydá PLATNOU relaci pro účet z DEV_LOGIN_EMAIL, aniž by se ptala na heslo
 * a na druhý faktor. Autentizace se tím nemění – relace prochází stejnou
 * cestou jako po normálním přihlášení, včetně klouzavé expirace a odhlášení.
 * Mění se jen to, že se vydá bez ověření.
 *
 * Proč takhle a ne vypnutím kontrol na stránkách: kontroly přihlášení jsou
 * v téhle aplikaci bezpečnostní hranicí a jejich obcházení v kódu stránek by
 * se při úklidu snadno někde zapomnělo. Takhle je celá zkratka v jednom
 * souboru, který se smaže jedním příkazem, a bez proměnné v prostředí nefunguje.
 *
 * V produkci je nedosažitelná dvakrát: aplikace s nastavenou DEV_LOGIN_EMAIL
 * vůbec nenastartuje (src/lib/env.ts) a tahle cesta se navíc tváří, že
 * neexistuje.
 */
export async function GET(): Promise<Response> {
  if (env.NODE_ENV === 'production' || !env.DEV_LOGIN_EMAIL) {
    return notFoundResponse()
  }

  const email = env.DEV_LOGIN_EMAIL.trim().toLowerCase()

  const user = await resolverClient.user.findUnique({
    where: { email },
    select: {
      id: true,
      practiceId: true,
      status: true,
      totpConfirmedAt: true,
      practice: { select: { sessionIdleMinutes: true } },
    },
  })

  if (!user || user.status !== 'ACTIVE') {
    return new Response(
      `Vývojová zkratka: účet ${email} v databázi není, nebo je zablokovaný.\n` +
        'Spusťte npm run db:seed, nebo opravte DEV_LOGIN_EMAIL v .env.',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    )
  }

  /*
   * Druhý faktor se u tohohle účtu označí za nastavený. Bez toho by aplikace
   * poslala obsluhu na jeho nastavení a zkratka by nic neušetřila. Je to taky
   * důvod, proč tahle cesta nemá co dělat nikde než na vývoji.
   */
  if (!user.totpConfirmedAt) {
    // Přes aplikační roli v kontextu ordinace. Rozlišovací role smí na tabulce
    // uživatelů měnit jen počítadla přihlášení, ne druhý faktor – a je to tak
    // správně, takže se grant kvůli vývojové zkratce nerozšiřuje.
    await withPractice(user.practiceId, (db) =>
      db.user.update({ where: { id: user.id }, data: { totpConfirmedAt: new Date() } }),
    )
  }

  const { token, absoluteExpiresAt } = await createSession({
    userId: user.id,
    idleMinutes: user.practice.sessionIdleMinutes,
    context: await getRequestContext(),
  })

  // Relace se rovnou označí za ověřenou druhým faktorem. Tabulka session patří
  // výhradně rozlišovací roli – aplikační na ni nemá žádná práva.
  await resolverClient.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { totpVerifiedAt: new Date() },
  })

  await setSessionCookie(token, absoluteExpiresAt)

  console.warn(
    `[medpredani] VÝVOJOVÁ ZKRATKA: vydána relace pro ${email} bez hesla a bez druhého faktoru.`,
  )

  redirect('/')
}
