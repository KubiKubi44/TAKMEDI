import { notFound } from 'next/navigation'

import { Button } from '@/components/ui'
import { withPractice } from '@/lib/db'
import { HandoffError, resolvePracticeFromTag } from '@/lib/handoff'
import { KodForm } from '../kod-form'

/**
 * Stránka, která se pacientovi otevře po přiložení telefonu k čipu.
 *
 * Tohle je jediné místo v aplikaci, kde se dá zadat kód předání. Že se sem
 * návštěvník dostal, znamená, že měl telefon fyzicky u čipu v ordinaci –
 * a právě na tom stojí bezpečnost čtyřmístného kódu.
 *
 * Neznámá ordinace, neplatné tajemství čipu i odvolaný čip vedou na STEJNOU
 * stránku 404. Kdyby se odpovědi lišily, dalo by se podle nich zjistit, které
 * ordinace tu jsou a jestli tajemství někdy platilo.
 *
 * Rámec stránky (název ordinace, adresa) je schválně opsaný z /o/<slug>,
 * ne vytažený do společného souboru: obě stránky musí nezvanému návštěvníkovi
 * vypadat úplně stejně a je lepší mít text na očích v obou souborech než
 * v jednom sdíleném, kde by se rozdíl snadno přehlédl.
 */

// Stav předání se mění každou chvíli a platí jen pár minut. Uložená kopie
// stránky by pacientovi tvrdila, že nic nečeká, i když už čeká.
export const dynamic = 'force-dynamic'

const TVAR_SLUGU = /^[A-Za-z0-9._-]{1,64}$/
/** Tajemství čipu je base64url z náhodných bajtů. */
const TVAR_TAJEMSTVI = /^[A-Za-z0-9_-]{16,64}$/

export default async function CipPage({
  params,
}: {
  params: Promise<{ slug: string; tagSecret: string }>
}) {
  const { slug, tagSecret } = await params

  if (!TVAR_SLUGU.test(slug) || !TVAR_TAJEMSTVI.test(tagSecret)) notFound()

  const practice = await najdiOrdinaci(slug, tagSecret)
  const ceka = await cekaPredani(practice.id)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-8 px-6 py-12">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-text-tlumeny">MedPředání</p>
        <h1 className="mt-1 text-3xl font-semibold leading-tight">{practice.name}</h1>
        {practice.addressLine ? (
          <p className="mt-2 text-lg text-text-tlumeny">{practice.addressLine}</p>
        ) : null}
      </header>

      {ceka ? (
        <div className="space-y-7">
          <p className="text-xl leading-relaxed">
            Lékař pro vás připravil dokumenty. Otevřou se, jakmile opíšete čtyři číslice z jeho
            obrazovky.
          </p>
          {/*
            Tajemství z adresy se předává do formuláře, aby ho šlo poslat zpět
            na server. Ven z aplikace se nedostane: odkazy na cizí stránky tu
            nejsou, obrázky ani skripty odjinud také ne.
          */}
          <KodForm slug={slug} tagSecret={tagSecret} />
        </div>
      ) : (
        <div className="space-y-7">
          <p className="text-xl leading-relaxed">
            Momentálně tu na vás nic nečeká. Požádejte prosím lékaře o předání.
          </p>
          {/*
            Formulář bez atributu action míří na aktuální adresu, takže
            stránku obnoví i bez JavaScriptu a tajemství čipu se přitom
            neopisuje do odkazu ve stránce.
          */}
          <form>
            <Button type="submit" variant="vedlejsi" size="velke" className="w-full">
              Zkusit znovu
            </Button>
          </form>
        </div>
      )}
    </main>
  )
}

async function najdiOrdinaci(slug: string, tagSecret: string) {
  try {
    const { practice } = await resolvePracticeFromTag(slug, tagSecret)
    return practice
  } catch (error) {
    if (error instanceof HandoffError) notFound()
    throw error
  }
}

/**
 * Čeká v ordinaci otevřené předání?
 *
 * Vrací se JEN ano/ne. Stránka je veřejná, takže se z ní nesmí dát vyčíst nic
 * o balíčku ani o pacientovi – ani počet dokumentů, ani kdy předání vzniklo.
 *
 * Řádky cizích ordinací nevrátí politika RLS v databázi, ne podmínka v tomhle
 * dotazu; ordinace se sem dostala z tajemství čipu, nikdy z adresy.
 */
async function cekaPredani(practiceId: string): Promise<boolean> {
  return withPractice(practiceId, async (db) => {
    // Vypršení se pozná porovnáním času, ne stavem v databázi: prošlou
    // aktivaci přepíše na EXPIRED až další pokus nebo noční úklid, do té doby
    // by se tvářila jako otevřená.
    const aktivace = await db.handoffActivation.findFirst({
      where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
      select: { id: true },
    })

    return aktivace !== null
  })
}
