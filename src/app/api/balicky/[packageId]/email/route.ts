import { z } from 'zod'

import { getApiUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { EmailDispatchError, sendPackageByEmail } from '@/lib/email-dispatch'
import { jsonResponse } from '@/lib/http'
import { hitRateLimit } from '@/lib/rate-limit'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Odeslání balíčku pacientovi e-mailem.
 *
 * Adresa pacienta chodí VÝHRADNĚ v těle požadavku. V cestě ani v query by
 * zůstala v historii prohlížeče, v logu reverzní proxy a v hlavičce Referer –
 * tedy na třech místech, ze kterých ji ordinace nikdy nesmaže.
 *
 * Odpověď nese PIN. V čitelné podobě existuje jedinkrát, právě tady: do
 * databáze jde jen jako HMAC s pepperem a e-mailem se neposílá. Lékař ho řekne
 * pacientovi ústně, takže odkaz a kód putují každý jinou cestou a přístup
 * k samotné schránce k otevření dokumentů nestačí.
 */

/** Nesmysl v adrese má skončit srozumitelnou větou, ne chybou z databáze. */
const TVAR_ID = /^[0-9a-f-]{36}$/i

/**
 * Adresa se ořezává, protože na tabletu se za ni snadno dostane mezera
 * z klávesnice nebo ze schránky. Strop 254 znaků je maximum podle RFC 5321 –
 * cokoli delšího je překlep, ne adresa.
 */
const TELO = z.object({
  recipient: z.string().trim().max(254).pipe(z.email()),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ packageId: string }> },
): Promise<Response> {
  const session = await getApiUser()
  if (!session) return jsonResponse({ error: 'Přihlášení vypršelo. Načtěte stránku znovu.' }, 401)

  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) {
      return jsonResponse({ error: 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.' }, 403)
    }
    throw error
  }

  const { packageId } = await params
  if (!TVAR_ID.test(packageId)) {
    return jsonResponse({ error: 'Neplatný balíček.' }, 400)
  }

  const limit = await hitRateLimit({
    action: 'email',
    identifier: session.userId,
    limit: 30,
    windowSeconds: 300,
  })
  if (!limit.allowed) {
    return jsonResponse({ error: 'Příliš mnoho odeslaných e-mailů po sobě. Chvíli počkejte.' }, 429)
  }

  const telo: unknown = await request.json().catch(() => null)
  const parsed = TELO.safeParse(telo)
  if (!parsed.success) {
    // Hláška adresu neopakuje – odpověď může skončit v logu prohlížeče.
    return jsonResponse({ error: 'Zadejte prosím platnou e-mailovou adresu pacienta.' }, 400)
  }

  const context = await getRequestContext()

  try {
    // Platnost odkazu i název ordinace se berou z databáze, ne z relace:
    // relace vznikla při přihlášení a admin mohl nastavení mezitím změnit.
    const ordinace = await withPractice(session.user.practiceId, (db) =>
      db.practice.findUniqueOrThrow({
        where: { id: session.user.practiceId },
        select: { name: true, linkTtlDays: true },
      }),
    )

    const { pin } = await sendPackageByEmail({
      practiceId: session.user.practiceId,
      practiceName: ordinace.name,
      userId: session.userId,
      userName: session.user.name,
      packageId,
      recipient: parsed.data.recipient,
      linkTtlDays: ordinace.linkTtlDays,
      context,
    })

    return jsonResponse({ pin }, 201)
  } catch (error) {
    // Hlášky odsud jsou už české a mířené na lékaře. Patří sem i selhání
    // odesílatele, proto 409, a ne 500: balíček i token existují, jen se
    // zpráva nedoručila a stojí za to akci zopakovat.
    if (error instanceof EmailDispatchError) {
      return jsonResponse({ error: error.message }, 409)
    }

    /*
     * Do logu jde jen samotná chyba. Adresa příjemce se v ní objevit nemůže:
     * jediný krok, který ji v čitelné podobě vidí, je odesílatel pošty, a ten
     * své selhání převádí na EmailDispatchError o řádek výš. PIN nevidí nikdo
     * kromě odpovědi.
     */
    console.error('[medpredani] odeslání balíčku e-mailem selhalo', error)
    return jsonResponse(
      { error: 'E-mail se nepodařilo odeslat. Zkuste to prosím znovu, nebo použijte tisk.' },
      500,
    )
  }
}
