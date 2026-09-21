'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'

import { Button, Card, Input } from '@/components/ui'
import type { ProblemVolba } from './priprava'

/**
 * Výběr problému, se kterým pacient odchází.
 *
 * Hledá se v prohlížeči nad seznamem, který přišel ze serveru už vykreslený.
 * Pro ordinaci s desítkami problémů je to nejrychlejší možná odezva – výsledky
 * se mění při psaní bez jediného požadavku po síti. Pro větší knihovnu bude
 * potřeba hledání na serveru (viz searchProblems v src/lib/library.ts), které
 * umí podobnost slov a překlepy.
 */

/** Delší výraz nemá smysl – hledá se v názvu problému a v kódu MKN-10. */
const MAX_DOTAZ = 100

type VyberProblemuProps = {
  problemy: ProblemVolba[]
  vybrany: ProblemVolba | null
  onVybrat: (problem: ProblemVolba) => void
  onZrusit: () => void
}

export function VyberProblemu({ problemy, vybrany, onVybrat, onZrusit }: VyberProblemuProps) {
  const [dotaz, setDotaz] = useState('')
  const poleRef = useRef<HTMLInputElement>(null)

  /**
   * Zaměření pole jen tam, kde se ovládá myší nebo klávesnicí.
   *
   * Na počítači tím lékař ušetří kliknutí při každém předání. Na tabletu by
   * ale vyskočila softwarová klávesnice a zakryla půlku obrazovky ještě dřív,
   * než se stihne podívat, co na ní je. Rozlišuje se proto druh ukazovacího
   * zařízení, ne šířka obrazovky.
   */
  useEffect(() => {
    if (vybrany) return
    if (typeof window === 'undefined') return
    if (!window.matchMedia('(pointer: fine)').matches) return

    // select(), ne jen focus(): po návratu tlačítkem „Změnit“ je v poli ještě
    // předchozí výraz a psaní ho má rovnou přepsat, ne se za něj připisovat.
    poleRef.current?.focus()
    poleRef.current?.select()
  }, [vybrany])

  /** Normalizovaná podoba se počítá jednou, ne při každém stisku klávesy. */
  const rejstrik = useMemo(
    () =>
      problemy.map((problem) => ({
        problem,
        nazev: bezDiakritiky(problem.name),
        kod: problem.icd10 ? bezDiakritiky(problem.icd10) : '',
      })),
    [problemy],
  )

  const hledane = bezDiakritiky(dotaz.trim())

  const nalezene = useMemo(() => {
    if (!hledane) return problemy

    return rejstrik
      .filter((polozka) => polozka.nazev.includes(hledane) || polozka.kod.includes(hledane))
      // Přesná shoda kódu MKN-10 patří nahoru, stejně jako při hledání na serveru.
      .sort((a, b) => Number(b.kod === hledane) - Number(a.kod === hledane))
      .map((polozka) => polozka.problem)
  }, [hledane, problemy, rejstrik])

  if (vybrany) {
    return (
      <section aria-labelledby="nadpis-problem">
        <h2 id="nadpis-problem" className="sr-only">
          Vybraný problém
        </h2>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border-2 border-hlavni bg-hlavni/5 px-5 py-4">
          <p className="min-w-0">
            <span className="block text-sm font-medium tracking-wide text-text-tlumeny uppercase">
              Vybráno
            </span>
            <span className="block text-lg leading-snug font-semibold">{vybrany.name}</span>
          </p>

          <Button variant="vedlejsi" type="button" onClick={onZrusit}>
            Změnit
          </Button>
        </div>
      </section>
    )
  }

  if (problemy.length === 0) {
    return (
      <Card className="sm:p-8">
        <h2 className="text-xl font-semibold">Knihovna je zatím prázdná</h2>

        <p className="mt-3 max-w-2xl text-text-tlumeny">
          Předávání stojí na knihovně: do problému jako „Po operaci kolene“ nahrajete letáky a
          pokyny, které k němu pacientovi patří. Při předání pak stačí problém najít a jeho
          dokumenty se předvyberou samy.
        </p>

        <Link
          href="/knihovna"
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-hlavni px-5 text-base font-semibold text-white transition-colors hover:bg-hlavni-tmavy"
        >
          Otevřít knihovnu
        </Link>

        <p className="mt-6 max-w-2xl text-sm text-text-tlumeny">
          Samotnou lékařskou zprávu můžete pacientovi předat i teď – nahrajte ji níže a
          vytiskněte.
        </p>
      </Card>
    )
  }

  return (
    <section aria-labelledby="nadpis-problem" className="space-y-3">
      <h2 id="nadpis-problem" className="sr-only">
        Hledání problému
      </h2>

      <div className="relative">
        <label htmlFor="hledani-problemu" className="sr-only">
          Hledat problém nebo kód MKN-10
        </label>
        <Input
          id="hledani-problemu"
          ref={poleRef}
          type="search"
          value={dotaz}
          onChange={(event) => setDotaz(event.target.value)}
          placeholder="Hledat problém nebo kód MKN-10"
          maxLength={MAX_DOTAZ}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          // Systémový křížek v poli typu search je na dotek malý, kreslí se
          // vlastní.
          className="pr-14 [&::-webkit-search-cancel-button]:appearance-none"
        />

        {dotaz ? (
          <button
            type="button"
            onClick={() => {
              setDotaz('')
              poleRef.current?.focus()
            }}
            className="absolute inset-y-0 right-0 flex w-14 items-center justify-center rounded-r-xl text-text-tlumeny transition-colors hover:text-text"
          >
            <span className="sr-only">Vymazat hledání</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* Živá oblast je v DOM pořád. Kdyby se objevila až s výsledky,
          odečítač obrazovky by ji při psaní spolehlivě nepřečetl. */}
      <p role="status" className="sr-only">
        {souhrnVysledku(dotaz.trim(), nalezene.length)}
      </p>

      {nalezene.length === 0 ? (
        <p className="rounded-2xl border border-obrys bg-plocha px-5 py-4 text-text-tlumeny">
          Pro „{dotaz.trim()}“ nemá knihovna žádný problém. Zkuste kratší výraz – třeba jen
          „koleno“ – nebo zadejte kód MKN-10.
        </p>
      ) : (
        /* Dlouhý seznam se roluje uvnitř rámečku, aby zůstal na dosah zbytek
           obrazovky: nahrání zprávy i tlačítka pro předání. */
        <ul className="max-h-104 space-y-2 overflow-y-auto">
          {nalezene.map((problem) => (
            <li key={problem.id}>
              <button
                type="button"
                onClick={() => onVybrat(problem)}
                className="flex min-h-16 w-full items-center gap-4 rounded-2xl border border-obrys bg-plocha px-5 py-4 text-left shadow-sm transition-colors hover:border-hlavni"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-lg leading-snug font-semibold">{problem.name}</span>

                  <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {problem.icd10 ? (
                      <span className="inline-flex items-center rounded-md border border-obrys bg-podklad px-2 py-0.5 font-mono text-xs font-medium tracking-wide text-text-tlumeny uppercase">
                        {problem.icd10}
                      </span>
                    ) : null}

                    <span className="text-sm text-text-tlumeny">
                      {pocetDokumentu(problem.documents.length)}
                    </span>
                  </span>
                </span>

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
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Porovnává se bez diakritiky a bez ohledu na velikost písmen.
 *
 * Lékař píše ve spěchu a „koleno“ musí najít „Po operaci kolene“ i „Kolénní…“.
 * Rozklad na NFD oddělí háčky a čárky jako samostatné znaky, takže je stačí
 * zahodit – „řež“ se tím srovná s „rez“.
 */
function bezDiakritiky(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

function souhrnVysledku(dotaz: string, pocet: number): string {
  if (pocet === 0) return `Pro „${dotaz}“ se nenašel žádný problém.`
  if (!dotaz) return `V knihovně ${pocet === 1 ? 'je' : 'jsou'} ${pocetProblemu(pocet)}.`
  return `Pro „${dotaz}“ se nabízí ${pocetProblemu(pocet)}.`
}

function pocetProblemu(pocet: number): string {
  if (pocet === 1) return '1 problém'
  if (pocet >= 2 && pocet <= 4) return `${pocet} problémy`
  return `${pocet} problémů`
}

function pocetDokumentu(pocet: number): string {
  if (pocet === 0) return 'Zatím žádný dokument'
  if (pocet === 1) return '1 dokument'
  if (pocet >= 2 && pocet <= 4) return `${pocet} dokumenty`
  return `${pocet} dokumentů`
}
