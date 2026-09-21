import type { Metadata } from 'next'
import Link from 'next/link'

import { Hlavicka } from '@/components/hlavicka'
import { Card } from '@/components/ui'
import { canManageLibrary, isPracticeAdmin, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { listProblems, searchProblems, type ProblemHit } from '@/lib/library'
import { Hledani } from './hledani'

/**
 * Přehled knihovny – problémy a jejich dokumenty.
 *
 * Oprávnění se ověřuje tady, ne v layoutu: layout se při navigaci mezi
 * stránkami znovu nevykresluje a nerozhoduje o tom, jestli se zbytek cesty
 * spočítá. Bezpečnostní hranicí je stránka a Server Action.
 *
 * Číst knihovnu smí kdokoli z ordinace včetně sestry – dokumenty potřebuje
 * při přípravě balíčku. Zakládat a měnit je smí jen ten, koho pustí
 * canManageLibrary(), takže odkazy na úpravy se sestře vůbec nevykreslí.
 */

export const metadata: Metadata = {
  title: 'Knihovna – MedPředání',
}

/** Kolik výsledků se vypíše. Číslo se zmiňuje i v hlášce o oříznutí. */
const RESULT_LIMIT = 20

/** Stejný strop, jaký má pole v hledani.tsx. */
const MAX_QUERY_LENGTH = 100

/**
 * Odkaz vypadající jako tlačítko.
 *
 * Button z ui.tsx vykresluje <button>, a tohle je navigace: musí to být
 * poctivé <a>, aby fungovalo prostřední tlačítko myši, otevření na nové kartě
 * i stránka bez JavaScriptu.
 */
const BUTTON_BASE =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition-colors'
const BUTTON_PRIMARY = `${BUTTON_BASE} bg-hlavni text-white hover:bg-hlavni-tmavy`
const BUTTON_SECONDARY = `${BUTTON_BASE} border-2 border-obrys bg-plocha text-text hover:border-hlavni`

export default async function KnihovnaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  const session = await requireUser()
  const params = await searchParams

  // Z adresy může přijít parametr i vícekrát; bere se první a ořízne se na
  // rozumnou délku, ať se do dotazu ani do hlášek nedostane celý odstavec.
  const raw = Array.isArray(params.q) ? params.q[0] : params.q
  const query = (raw ?? '').trim().slice(0, MAX_QUERY_LENGTH)

  const { hits, libraryEmpty } = await withPractice(session.user.practiceId, async (db) => {
    const hits = await searchProblems(db, query, RESULT_LIMIT)

    // Prázdný výsledek hledání a prázdná knihovna potřebují úplně jinou
    // nápovědu. Rozlišit se dají jen druhým dotazem, a ten stojí za to udělat
    // jen tehdy, když se opravdu nic nenašlo.
    const empty =
      hits.length === 0 && (query === '' || (await listProblems(db, 1)).length === 0)

    return { hits, libraryEmpty: empty }
  })

  const canManage = canManageLibrary(session.user)

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-5xl px-6 py-8 sm:py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Knihovna dokumentů</h1>
            <p className="mt-1 max-w-2xl text-text-tlumeny">
              Problémy, ke kterým má ordinace připravené letáky a pokyny pro pacienty.
            </p>
          </div>

          {canManage ? (
            <Link href="/knihovna/novy" className={BUTTON_PRIMARY}>
              Nový problém
            </Link>
          ) : null}
        </header>

        <div className="mt-6">
          <Hledani />
        </div>

        {/*
          Živá oblast je v DOM pořád, i když je prázdná. Kdyby se teď objevila,
          odečítač obrazovky ji při výměně výsledků spolehlivě nepřečte.
        */}
        <p
          role="status"
          className={hits.length > 0 ? 'mt-6 text-sm text-text-tlumeny' : 'sr-only'}
        >
          {resultSummary(query, hits.length, libraryEmpty)}
        </p>

        {hits.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {hits.map((hit) => (
              <li key={hit.id}>
                <ProblemCard hit={hit} />
              </li>
            ))}
          </ul>
        ) : libraryEmpty ? (
          <EmptyLibrary canManage={canManage} />
        ) : (
          <NoResults query={query} canManage={canManage} />
        )}
      </main>
    </div>
  )
}

function ProblemCard({ hit }: { hit: ProblemHit }) {
  return (
    <Link
      href={`/knihovna/${hit.id}`}
      className={[
        // min-h-16 je 4 rem, tedy 68 px při zdejší velikosti písma – dost
        // velká plocha na dotek prstem na tabletu.
        'flex min-h-16 items-center gap-4 rounded-2xl border bg-plocha px-5 py-4 shadow-sm transition-colors',
        hit.exactCode ? 'border-hlavni' : 'border-obrys hover:border-hlavni',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <span className="block text-lg leading-snug font-semibold">{hit.name}</span>

        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {hit.icd10 ? (
            <span className="inline-flex items-center rounded-md border border-obrys bg-podklad px-2 py-0.5 font-mono text-xs font-medium tracking-wide text-text-tlumeny uppercase">
              {hit.icd10}
            </span>
          ) : null}

          {hit.exactCode ? (
            <span className="inline-flex items-center rounded-md border border-hlavni/30 bg-hlavni/10 px-2 py-0.5 text-xs font-semibold text-hlavni-tmavy">
              přesná shoda
            </span>
          ) : null}

          <span className="text-sm text-text-tlumeny">{documentCountLabel(hit.documentCount)}</span>
        </span>
      </div>

      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-5 w-5 shrink-0 text-text-tlumeny"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 4l6 6-6 6" />
      </svg>
    </Link>
  )
}

function EmptyLibrary({ canManage }: { canManage: boolean }) {
  return (
    <Card className="mt-6 sm:p-10">
      <h2 className="text-xl font-semibold">Knihovna je zatím prázdná</h2>

      <p className="mt-3 max-w-2xl text-text-tlumeny">
        Problém je skupina dokumentů k jedné diagnóze nebo situaci – například „Po operaci
        kolene“. Dáte mu název, případně kód MKN-10, a nahrajete do něj letáky a pokyny,
        které k němu pacientovi patří.
      </p>
      <p className="mt-3 max-w-2xl text-text-tlumeny">
        Při předávání pak stačí problém najít a jeho dokumenty se pacientovi nabídnou samy.
        Vyplatí se začít tím, co ordinace tiskne nejčastěji.
      </p>

      {canManage ? (
        <Link href="/knihovna/novy" className={`${BUTTON_PRIMARY} mt-8`}>
          Založit první problém
        </Link>
      ) : (
        <p className="mt-8 max-w-2xl text-text-tlumeny">
          Knihovnu naplňuje lékař nebo administrátor ordinace. Jakmile tu první problém bude,
          uvidíte ho na téhle stránce.
        </p>
      )}
    </Card>
  )
}

function NoResults({ query, canManage }: { query: string; canManage: boolean }) {
  return (
    <Card className="mt-6 sm:p-10">
      <h2 className="text-xl font-semibold">Nic se nenašlo</h2>

      <p className="mt-3 max-w-2xl text-text-tlumeny">
        Pro „{query}“ nemá knihovna žádný problém. Zkuste kratší výraz – třeba jen „koleno“
        místo celého názvu – nebo zadejte kód MKN-10.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/knihovna" className={BUTTON_SECONDARY}>
          Vymazat hledání
        </Link>

        {canManage ? (
          <Link
            href={`/knihovna/novy?nazev=${encodeURIComponent(query)}`}
            className={BUTTON_PRIMARY}
          >
            Založit problém „{shorten(query)}“
          </Link>
        ) : null}
      </div>

      {canManage ? null : (
        <p className="mt-6 max-w-2xl text-text-tlumeny">
          Nový problém do knihovny zakládá lékař nebo administrátor ordinace.
        </p>
      )}
    </Card>
  )
}

/** Dlouhý dotaz by roztáhl popisek tlačítka přes celou obrazovku. */
function shorten(value: string): string {
  return value.length > 32 ? `${value.slice(0, 32).trimEnd()}…` : value
}

/**
 * Věta o počtu výsledků. Sedí v živé oblasti, takže při hledání za běhu
 * odečítač obrazovky řekne, kolik se toho našlo – bez ní by se seznam vyměnil potichu.
 */
function resultSummary(query: string, count: number, libraryEmpty: boolean): string {
  if (count === 0) {
    return libraryEmpty
      ? 'Knihovna je zatím prázdná.'
      : `Pro „${query}“ se nenašel žádný problém.`
  }

  const verb = count === 1 ? 'našel' : count <= 4 ? 'našly' : 'našlo'
  const sentence = query
    ? `Pro „${query}“ se ${verb} ${problemCountLabel(count)}.`
    : `V knihovně ${count >= 2 && count <= 4 ? 'jsou' : 'je'} ${problemCountLabel(count)}.`

  // Delší výsledek dotaz ořízne. Uživatel má vědět, že vidí jen začátek.
  return count === RESULT_LIMIT
    ? `${sentence} Zobrazuje se prvních ${RESULT_LIMIT}, upřesněte prosím hledání.`
    : sentence
}

function documentCountLabel(count: number): string {
  if (count === 0) return 'Zatím žádný dokument'
  if (count === 1) return '1 dokument'
  if (count < 5) return `${count} dokumenty`
  return `${count} dokumentů`
}

function problemCountLabel(count: number): string {
  if (count === 1) return '1 problém'
  if (count < 5) return `${count} problémy`
  return `${count} problémů`
}
