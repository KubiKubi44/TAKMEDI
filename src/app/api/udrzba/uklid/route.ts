import { timingSafeEqual } from 'node:crypto'

import { runCleanup } from '@/lib/cleanup'
import { env } from '@/lib/env'
import { jsonResponse } from '@/lib/http'

/**
 * Úklid po expiraci, spouštěný cronem.
 *
 * Proč route handler a ne samostatný skript: úklid potřebuje šifrovací klíč
 * a přístup k úložišti, tedy přesně to, co je v aplikaci. Samostatný skript by
 * je musel mít taky, čímž by vznikl druhý kus kódu, který sahá na zdravotní
 * dokumentaci – a ten by se musel udržovat ve shodě s prvním.
 *
 * Cron pak dělá jen tohle:
 *   0 3 * * *  curl -fsS -X POST -H "X-Uklid-Token: ..." https://.../api/udrzba/uklid
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.CLEANUP_TOKEN) {
    return jsonResponse({ error: 'Úklid není nastavený.' }, 503)
  }

  const predlozeny = request.headers.get('x-uklid-token') ?? ''
  if (!constantTimeEquals(predlozeny, env.CLEANUP_TOKEN)) {
    // Stejná odpověď jako na neexistující cestu – ven se nesmí dostat ani to,
    // že tahle cesta existuje.
    return new Response('Nenalezeno', { status: 404 })
  }

  const zacatek = Date.now()
  const report = await runCleanup()

  console.info(
    `[medpredani] úklid hotov za ${Date.now() - zacatek} ms: ` +
      `${report.balicku} balíčků, ${report.souboru} souborů, ${report.tokenu} odkazů, ` +
      `${report.aktivaci} aktivací, ${report.relaci} relací, ${report.pocitadel} počítadel` +
      (report.chyby.length > 0 ? `, chyb: ${report.chyby.length}` : ''),
  )

  for (const chyba of report.chyby) console.error(`[medpredani] úklid: ${chyba}`)

  // Stav 500 při dílčí chybě, aby si toho cron všiml a ozval se.
  return jsonResponse(report, report.chyby.length > 0 ? 500 : 200)
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
