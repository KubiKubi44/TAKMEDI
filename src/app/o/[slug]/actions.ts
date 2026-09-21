'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { HandoffError, claimHandoff, resolvePracticeFromTag } from '@/lib/handoff'
import { hitRateLimit } from '@/lib/rate-limit'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Nárokování předání pacientem.
 *
 * Akci volá nepřihlášený člověk, přesto se i tady kontroluje původ požadavku.
 * Ochrana proti CSRF nechrání session – ta žádná není – ale brání tomu, aby
 * kód za pacienta zkoušela cizí stránka otevřená v jeho prohlížeči.
 *
 * Ordinace se bere z tajemství čipu, nikdy z adresy ani z formuláře, a počet
 * pokusů hlídá claimHandoff globálně na aktivaci. Tenhle soubor tedy jen
 * překládá formulář na volání jádra a chybu z něj vrací tak, jak přišla:
 * hlášky z HandoffError jsou už české a psané pro pacienta.
 */

export type KodState = { error?: string }

const CHYBA_CIZI_PUVOD = 'Kód se nepodařilo odeslat. Načtěte prosím stránku znovu.'
const CHYBA_TVAR_KODU = 'Opište prosím čtyři číslice z obrazovky u lékaře.'
const CHYBA_OBECNA = 'Něco se pokazilo. Přiložte prosím telefon k ordinaci znovu.'
const CHYBA_PRILIS_CASTO = 'Zkoušíte to příliš často. Počkejte prosím chvíli a zkuste to znovu.'

const KodSchema = z.object({
  // Obě hodnoty pocházejí ze skrytých polí naší vlastní stránky. Kontrola
  // tvaru tu je proto, aby se nesmysl zastavil dřív, než sáhne do databáze.
  slug: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  tagSecret: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  kod: z.string().regex(/^[0-9]{4}$/, { error: CHYBA_TVAR_KODU }),
})

function precistPole(formData: FormData) {
  const kod = formData.get('kod')

  return {
    slug: formData.get('slug'),
    tagSecret: formData.get('tagSecret'),
    // Kód se opisuje z obrazovky a mezera mezi číslicemi se udělá snadno;
    // odmítnout kvůli ní správný kód by byla zbytečná otrava.
    kod: typeof kod === 'string' ? kod.replace(/\s+/g, '') : kod,
  }
}

export async function claimCode(_prev: KodState, formData: FormData): Promise<KodState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const parsed = KodSchema.safeParse(precistPole(formData))
  if (!parsed.success) {
    // Ze zprávy nesmí jít poznat, které pole vadilo – pacient stejně vyplňuje
    // jen kód a o zbytku formuláře nemá co vědět.
    const tree = z.treeifyError(parsed.error)
    return { error: tree.properties?.kod?.errors?.[0] ?? CHYBA_OBECNA }
  }

  const vysledek = await narokovat(parsed.data)
  if (!vysledek.ok) return { error: vysledek.error }

  // Mimo try/catch: redirect() pracuje s výjimkou, kterou musí zpracovat Next.
  redirect(`/d/${vysledek.token}`)
}

/**
 * Oddělené kvůli přesměrování: kdyby claimHandoff volal redirect ve stejném
 * bloku, musel by být try/catch okolo něj – a ten by výjimku z redirect()
 * spolkl.
 */
async function narokovat(vstup: {
  slug: string
  tagSecret: string
  kod: string
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const context = await getRequestContext()

  // Počet pokusů o kód hlídá jádro globálně na aktivaci (pět, pak zámek) –
  // tohle je jen proti zahlcení: opakované odesílání formuláře z jedné adresy
  // nemá zdržovat ordinaci ani databázi. Limit je natolik vysoko, že na
  // skutečné předání nedosáhne.
  if (context.ip) {
    const limit = await hitRateLimit({
      action: 'predani-kod',
      identifier: context.ip,
      limit: 20,
      windowSeconds: 300,
    })
    if (!limit.allowed) return { ok: false, error: CHYBA_PRILIS_CASTO }
  }

  try {
    const { practice, tagId } = await resolvePracticeFromTag(vstup.slug, vstup.tagSecret)
    const { token } = await claimHandoff({ practice, tagId, code: vstup.kod, context })
    return { ok: true, token }
  } catch (error) {
    if (error instanceof HandoffError) return { ok: false, error: error.message }
    throw error
  }
}
