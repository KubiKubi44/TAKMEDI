import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Hlavicka } from '@/components/hlavicka'
import { Alert, Card } from '@/components/ui'
import { canManageLibrary, isPracticeAdmin, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { getProblemDetail, type LibraryDocument } from '@/lib/library'
import { Dokumenty, type DokumentPolozka } from './dokumenty'
import { NahratDokument } from './nahrat'

/**
 * Detail problému a dokumenty, které se k němu pacientovi předávají.
 *
 * Oprávnění se ověřuje tady, ne v layoutu – layout se při navigaci mezi
 * stránkami nevykresluje znovu a nerozhoduje o tom, jestli se zbytek cesty
 * spočítá. Sestra sem smí: balíček připravuje také a potřebuje si dokument
 * otevřít. Měnit knihovnu smí jen lékař a admin ordinace.
 */

export const metadata: Metadata = {
  title: 'Knihovna – MedPředání',
}

/**
 * Odkaz, který vypadá jako tlačítko.
 *
 * Náhled je navigace, ne akce – musí to být poctivé <a>, aby fungovalo
 * otevření na nové kartě i prostřední tlačítko myši. Button z ui.tsx
 * vykresluje <button>, proto se třídy opisují. Drží se stejného tvaru jako
 * vedlejší tlačítko, aby seznam vypadal jednotně.
 */
const ODKAZ_JAKO_TLACITKO =
  'inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-obrys bg-plocha px-5 text-base font-semibold text-text transition-colors hover:border-hlavni'

/** Nesmysl v adrese má skončit stránkou 404, ne chybou z databáze. */
const TVAR_ID = /^[0-9a-f-]{36}$/i

/**
 * Data se formátují na serveru, i když je vykreslí komponenta v prohlížeči.
 * Server běží v UTC a prohlížeč v zóně uživatele – kdyby si datum poskládal
 * každý sám, React by po hydrataci hlásil rozdíl a datum by po načtení
 * stránky poskočilo.
 */
const FORMAT_DATA = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/Prague',
})

const FORMAT_CISLA = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 })

function velikost(bytes: number | null): string | null {
  if (bytes === null) return null
  // Pod megabajtem se desetiny nehodí a nula kilobajtů by mátla.
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`
  return `${FORMAT_CISLA.format(bytes / 1024 / 1024)} MB`
}

function pocetStran(pages: number): string {
  if (pages === 1) return '1 strana'
  if (pages >= 2 && pages <= 4) return `${pages} strany`
  return `${pages} stran`
}

/** Jednořádkový popis dokumentu: „verze 3 · 2 strany · 420 kB · změněno 17. 9. 2026“. */
function popisDokumentu(doc: LibraryDocument): string {
  const casti: string[] = []

  if (doc.version === null) {
    casti.push('zatím bez souboru')
  } else {
    casti.push(`verze ${doc.version}`)
    if (doc.pageCount !== null) casti.push(pocetStran(doc.pageCount))
    const velikostSouboru = velikost(doc.sizeBytes)
    if (velikostSouboru) casti.push(velikostSouboru)
  }

  casti.push(`změněno ${FORMAT_DATA.format(doc.updatedAt)}`)

  return casti.join(' · ')
}

export default async function ProblemPage({
  params,
}: {
  params: Promise<{ problemId: string }>
}) {
  const session = await requireUser()
  const { problemId } = await params

  if (!TVAR_ID.test(problemId)) notFound()

  const detail = await withPractice(session.user.practiceId, (db) =>
    getProblemDetail(db, problemId),
  )

  // Cizí problém politika RLS nevrátí, takže null znamená „neexistuje, nebo
  // není náš“. Obojí vypadá navenek stejně – jinak by se dalo zjistit, co má
  // v knihovně jiná ordinace.
  if (!detail) notFound()

  const smiSpravovat = canManageLibrary(session.user)

  const polozky: DokumentPolozka[] = detail.documents.map((doc) => ({
    id: doc.id,
    title: doc.title,
    sortOrder: doc.sortOrder,
    archivedAt: doc.archivedAt ? FORMAT_DATA.format(doc.archivedAt) : null,
    version: doc.version,
    pageCount: doc.pageCount,
    currentVersionId: doc.currentVersionId,
    popis: popisDokumentu(doc),
  }))

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <nav aria-label="Drobečková navigace">
          <Link
            href="/knihovna"
            className="inline-flex min-h-12 items-center font-medium text-text-tlumeny hover:text-hlavni"
          >
            <span aria-hidden="true" className="mr-2">
              &larr;
            </span>
            Zpět na knihovnu
          </Link>
        </nav>

        <header>
          {detail.icd10 ? (
            <p className="font-mono text-sm font-semibold tracking-wide text-text-tlumeny">
              {detail.icd10}
            </p>
          ) : null}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-2xl font-semibold">{detail.name}</h1>
            {smiSpravovat ? (
              <Link
                href={`/knihovna/${detail.id}/upravit`}
                className="text-sm text-text-tlumeny underline underline-offset-4 hover:text-hlavni"
              >
                Upravit název a kód
              </Link>
            ) : null}
          </div>
          {detail.note ? (
            <p className="mt-2 max-w-2xl whitespace-pre-line text-text-tlumeny">{detail.note}</p>
          ) : null}
        </header>

        {detail.archivedAt ? (
          <Alert tone="info">
            Tenhle problém je archivovaný. Při přípravě balíčku se nenabízí, jeho dokumenty ale
            zůstávají dostupné.
          </Alert>
        ) : null}

        <section aria-labelledby="nadpis-dokumenty" className="space-y-4">
          <h2 id="nadpis-dokumenty" className="text-xl font-semibold">
            Dokumenty
          </h2>

          {polozky.length === 0 ? (
            <Card className="space-y-4 sm:p-8">
              <h3 className="text-lg font-semibold">Zatím tu nic není</h3>
              <p className="max-w-2xl text-text-tlumeny">
                Sem patří PDF, která pacient dostane s sebou domů: poučení před výkonem, režim po
                zákroku, cviky, dieta. Až je nahrajete, nabídnou se samy pokaždé, když k tomuhle
                problému budete připravovat balíček.
              </p>
              {smiSpravovat ? (
                <>
                  <p className="text-sm text-text-tlumeny">
                    Nahrát můžete PDF nebo fotku či sken papírového letáku – ten se na PDF převede
                    sám. Název se vezme ze souboru, přejmenovat ho jde kdykoli potom.
                  </p>
                  <NahratDokument problemId={detail.id} popisek="Nahrát první dokument" />
                </>
              ) : (
                <p className="text-sm text-text-tlumeny">
                  Dokumenty do knihovny přidává lékař nebo administrátor ordinace.
                </p>
              )}
            </Card>
          ) : smiSpravovat ? (
            <>
              <Dokumenty documents={polozky} />
              <NahratDokument problemId={detail.id} popisek="Přidat další dokument" />
            </>
          ) : (
            <SeznamProCteni documents={polozky} />
          )}
        </section>
      </main>
    </div>
  )
}

/**
 * Seznam pro sestru: jen to, co si může otevřít.
 *
 * Ovládání se jí nenabízí vůbec, místo aby se zobrazilo a pak odmítlo – kdo
 * nemá co měnit, nemá se čím prokousávat. Server Actions si oprávnění hlídají
 * samy, tohle je ohled na obsluhu, ne ochrana.
 */
function SeznamProCteni({ documents }: { documents: DokumentPolozka[] }) {
  const aktivni = documents.filter((doc) => doc.archivedAt === null)
  const archivovane = documents.filter((doc) => doc.archivedAt !== null)

  return (
    <div className="space-y-6">
      {aktivni.length === 0 ? (
        // Prázdný orámovaný pruh vypadá jako nenačtená stránka. Sestra
        // dokumenty přidávat nemůže, takže se jí místo výzvy řekne, komu říct.
        <p className="rounded-2xl border border-obrys bg-plocha px-5 py-6 text-text-tlumeny">
          {archivovane.length > 0
            ? 'K tomuhle problému nejsou momentálně žádné aktivní dokumenty – všechny jsou archivované. Může je vrátit lékař nebo správce ordinace.'
            : 'K tomuhle problému zatím nejsou žádné dokumenty. Přidat je může lékař nebo správce ordinace.'}
        </p>
      ) : (
      <ul className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys bg-plocha shadow-sm">
        {aktivni.map((doc, index) => (
          <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="font-medium">
                <span className="mr-2 text-text-tlumeny tabular-nums">{index + 1}.</span>
                {doc.title}
              </p>
              <p className="mt-1 text-sm text-text-tlumeny">{doc.popis}</p>
            </div>
            <NahledOdkaz dokument={doc} />
          </li>
        ))}
      </ul>
      )}

      {archivovane.length > 0 ? (
        <div className="border-t border-obrys pt-6">
          <h3 className="text-sm font-medium uppercase tracking-wide text-text-tlumeny">
            Archivované
          </h3>
          <ul className="mt-3 space-y-3 opacity-60">
            {archivovane.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{doc.title}</p>
                  <p className="mt-1 text-sm text-text-tlumeny">
                    archivováno {doc.archivedAt} · {doc.popis}
                  </p>
                </div>
                <NahledOdkaz dokument={doc} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function NahledOdkaz({ dokument }: { dokument: DokumentPolozka }) {
  if (!dokument.currentVersionId) {
    return <span className="text-sm text-text-tlumeny">Bez souboru</span>
  }

  return (
    <a
      href={`/api/knihovna/verze/${dokument.currentVersionId}`}
      target="_blank"
      rel="noopener"
      className={ODKAZ_JAKO_TLACITKO}
      aria-label={`Náhled dokumentu ${dokument.title} (otevře se v nové záložce)`}
    >
      Náhled
    </a>
  )
}
