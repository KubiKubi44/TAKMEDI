import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import {
  openPatientPackage,
  PatientAccessError,
  recordPatientVisit,
  type PatientPackage,
} from '@/lib/patient'
import { getRequestContext, type RequestInfo } from '@/lib/request-context'

import { Dokumenty } from './dokumenty'
import { Overeni } from './overeni'

/**
 * Stránka, na které pacient najde své dokumenty.
 *
 * Otevírá ji na telefonu, jednou hned po návštěvě a pak často až za několik
 * týdnů, a čte ji člověk, který s aplikacemi běžně nepracuje. Odtud čtyři
 * věci, kterými se liší od zbytku aplikace:
 *
 * 1. Žádná hlavička aplikace. Hlavicka je pro personál a pacientovi by
 *    nabízela jen cesty, kam nesmí.
 * 2. Všechny důvody odmítnutí vypadají stejně. Z chybové stránky se nesmí dát
 *    poznat, jestli takový odkaz někdy existoval, jestli vypršel, nebo patří
 *    jiné ordinaci – veřejná stránka nemá na otázky útočníka odpovídat.
 * 3. Dokud neproběhne ověření, nevykreslí se ani název ordinace, ani počet
 *    dokumentů. Kdo odkaz otevřel omylem nebo ho dostal do ruky cizí, se
 *    nedozví vůbec nic.
 * 4. Žádný žargon. Pacient neví, co je token, balíček ani aktivace, a vědět
 *    to nepotřebuje.
 */

export const metadata: Metadata = {
  // Název se ukáže na záložce a v přehledu otevřených stránek, kam vidí
  // kdokoli kolem. Proto nic o ordinaci ani o pacientovi.
  title: 'Vaše dokumenty',
  robots: { index: false, follow: false },
}

export default async function StrankaPacienta({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const context = await getRequestContext()

  const balicek = await nactiBalicek(token, context)
  if (!balicek) return <OdkazNeplati />

  if (balicek.needsVerification) {
    // Schválně tu není nic dalšího: ani název ordinace, ani počet dokumentů.
    // Ověření má vpustit dovnitř, ne prozradit, co je uvnitř.
    return (
      <Obal>
        <Overeni token={token} zpusob={balicek.needsVerification} />
      </Obal>
    )
  }

  await recordPatientVisit(balicek.practiceId, balicek.tokenId, balicek.packageId, context)

  return (
    <Obal
      zahlavi={
        <>
          <p className="text-sm text-text-tlumeny">Dokumenty z vaší návštěvy</p>
          <p className="text-xl font-semibold leading-tight">{balicek.practiceName}</p>
        </>
      }
    >
      <Dokumenty
        token={token}
        dokumenty={balicek.documents.map((dokument) => ({
          id: dokument.id,
          nazev: dokument.title,
          stran: dokument.pageCount,
        }))}
        celkemStran={balicek.totalPages}
        platiDo={balicek.expiresAt}
      />
    </Obal>
  )
}

/**
 * Načtení balíčku, ve kterém je každé odmítnutí stejné.
 *
 * Důvod z PatientAccessError se schválně zahazuje. Rozlišit vypršelý odkaz od
 * neexistujícího by znamenalo potvrdit, že nějaký takový odkaz byl vydán.
 */
async function nactiBalicek(token: string, context: RequestInfo): Promise<PatientPackage | null> {
  try {
    return await openPatientPackage(token, context)
  } catch (chyba) {
    if (chyba instanceof PatientAccessError) return null
    throw chyba
  }
}

/** Společný rám stránky. Úzký sloupec, velké písmo, nic navíc. */
function Obal({ zahlavi, children }: { zahlavi?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      {zahlavi ? (
        <header className="border-b border-obrys bg-plocha">
          <div className="mx-auto w-full max-w-2xl px-5 py-5">{zahlavi}</div>
        </header>
      ) : null}

      <main className="mx-auto w-full max-w-2xl px-5 py-8 sm:py-10">{children}</main>
    </div>
  )
}

/**
 * Stránka pro odkaz, který nefunguje.
 *
 * Proč ne notFound(): odkaz, kterému vypršela platnost, není překlep v adrese.
 * Pacient se má dozvědět, co se stalo a co s tím, ne narazit na strohou 404.
 * Text je stejný pro všechny důvody a neobsahuje název ordinace – ten by
 * z chybové stránky udělal potvrzení, že odkaz k té ordinaci patřil.
 */
function OdkazNeplati() {
  return (
    <Obal>
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold">Tenhle odkaz už neplatí.</h1>

        <p className="text-lg">
          Odkazy na dokumenty platí jen omezenou dobu. Po jejím uplynutí se samy uzavřou a
          dokumenty se z nich smažou. Stejně tak nemusí fungovat odkaz, ze kterého se cestou
          ztratila část adresy.
        </p>

        <p className="text-lg">
          Nový odkaz vám vystaví ordinace, ve které jste dokumenty dostali. Stačí o něj požádat
          při další návštěvě nebo zavolat.
        </p>
      </div>
    </Obal>
  )
}
