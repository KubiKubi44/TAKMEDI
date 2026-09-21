import { notFound } from 'next/navigation'

import { HandoffError, resolvePracticeFromTag } from '@/lib/handoff'

/**
 * Veřejná stránka ordinace – to, co uvidí kdokoli, kdo adresu uhodne.
 *
 * NENÍ TU POLE NA KÓD, a je to bezpečnostní opatření, ne opomenutí. Kód
 * předání má čtyři číslice, tedy deset tisíc možností, a celá jeho síla stojí
 * na tom, že se k jeho zadání dostane jen ten, kdo telefon fyzicky přiložil
 * k čipu v ordinaci: adresa na čipu je /o/<slug>/<tajemství> a pole na kód je
 * až tam. Samotné /o/<slug> se přitom dá uhodnout z názvu ordinace. Kdyby se
 * kód dal zkoušet i odtud, mohl by ho hádat kdokoli z druhého konce světa
 * a čtyři číslice by přestaly stačit.
 *
 * Ze stejného důvodu tu není ani náznak toho, jestli zrovna něco čeká –
 * stránka vypadá pořád stejně.
 */

// Stránka se ptá databáze při každém zobrazení; jako statická by se mohla
// uložit do mezipaměti i s názvem, který ordinace mezitím změnila.
export const dynamic = 'force-dynamic'

/** Nesmysl v adrese má skončit stránkou 404, ne zbytečným dotazem do databáze. */
const TVAR_SLUGU = /^[A-Za-z0-9._-]{1,64}$/

export default async function OrdinacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  if (!TVAR_SLUGU.test(slug)) notFound()

  const practice = await najdiOrdinaci(slug)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-8 px-6 py-12">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-text-tlumeny">MedPředání</p>
        <h1 className="mt-1 text-3xl font-semibold leading-tight">{practice.name}</h1>
        {practice.addressLine ? (
          <p className="mt-2 text-lg text-text-tlumeny">{practice.addressLine}</p>
        ) : null}
      </header>

      <div className="space-y-5 text-xl leading-relaxed">
        <p>Tahle stránka slouží k předání dokumentů od lékaře do vašeho telefonu.</p>
        <p className="text-text-tlumeny">
          Až vám lékař řekne, že jsou dokumenty připravené, přiložte telefon k označenému místu
          v ordinaci. Stránka se pak otevře sama a vy už jen opíšete čtyři číslice z obrazovky
          u lékaře.
        </p>
      </div>
    </main>
  )
}

/**
 * Neznámá ordinace končí stránkou 404 – tedy stejně jako cokoli jiného, co
 * v aplikaci není. Návštěvník se nesmí dozvědět ani to, které ordinace tu jsou.
 */
async function najdiOrdinaci(slug: string) {
  try {
    const { practice } = await resolvePracticeFromTag(slug, null)
    return practice
  } catch (error) {
    if (error instanceof HandoffError) notFound()
    throw error
  }
}
