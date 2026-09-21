'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { Button, Input } from '@/components/ui'

/**
 * Hledání v knihovně.
 *
 * Píše se do adresy (?q=...), ne do stavu komponenty: výsledky počítá server,
 * takže hledání přežije obnovení stránky, dá se poslat kolegovi odkazem
 * a funguje i tlačítko zpět.
 *
 * Bez JavaScriptu zůstane obyčejný formulář s metodou GET a tlačítkem
 * „Hledat“. Napovídání za běhu je tedy vylepšení, ne podmínka.
 */

/** Bez zpoždění by se výsledky načítaly po každém stisku klávesy. */
const DEBOUNCE_MS = 300

/** Delší dotaz nemá smysl – hledá se v názvu problému nebo v kódu MKN-10. */
const MAX_QUERY_LENGTH = 100

function targetPath(value: string): string {
  const trimmed = value.trim()
  return trimmed ? `/knihovna?q=${encodeURIComponent(trimmed)}` : '/knihovna'
}

export function Hledani() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlQuery = searchParams.get('q') ?? ''

  const [query, setQuery] = useState(urlQuery)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Zaměření pole jen tam, kde se ovládá myší nebo klávesnicí.
   *
   * Na počítači je to úspora jednoho kliknutí při každém otevření knihovny.
   * Na tabletu by to ale vyvolalo softwarovou klávesnici, která zakryje půlku
   * výsledků – a to i při pouhém návratu tlačítkem zpět. Proto se rozlišuje
   * podle druhu ukazovacího zařízení, ne podle šířky obrazovky.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.matchMedia('(pointer: fine)').matches) return
    inputRef.current?.focus()
  }, [])

  /**
   * Co do adresy naposledy zapsala tahle komponenta.
   *
   * Odlišuje vlastní zápis od změny zvenčí (tlačítko zpět, odkaz „Vymazat
   * hledání“). Porovnává se s oříznutou hodnotou, jinak by srovnání pole
   * s adresou umazalo mezeru, kterou uživatel právě napsal uprostřed slov.
   */
  const writtenQuery = useRef(urlQuery)

  useEffect(() => {
    if (urlQuery === writtenQuery.current) return
    writtenQuery.current = urlQuery
    setQuery(urlQuery)
  }, [urlQuery])

  useEffect(() => {
    if (query.trim() === writtenQuery.current) return

    const timer = setTimeout(() => {
      writtenQuery.current = query.trim()
      // replace, ne push: každé písmeno by jinak přibylo do historie
      // prohlížeče a tlačítko zpět by se přes hledání dlouho prokousávalo.
      router.replace(targetPath(query), { scroll: false })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, router])

  function clearSearch() {
    setQuery('')
    writtenQuery.current = ''
    router.replace('/knihovna', { scroll: false })
    inputRef.current?.focus()
  }

  return (
    <form
      method="get"
      action="/knihovna"
      role="search"
      onSubmit={(event) => {
        // Po stisku Enter se nemá čekat na doběhnutí zpoždění. Bez
        // JavaScriptu se formulář odešle běžnou cestou a stránka se načte.
        event.preventDefault()
        writtenQuery.current = query.trim()
        router.replace(targetPath(query), { scroll: false })
      }}
      className="flex flex-wrap items-center gap-3"
    >
      {/* min-w-56 brání tomu, aby se pole na úzkém displeji smrsklo na pár znaků
          – místo toho se tlačítko „Hledat“ zalomí pod ně. */}
      <div className="relative min-w-56 flex-1">
        <label htmlFor="hledani-knihovna" className="sr-only">
          Hledat v knihovně
        </label>
        <Input
          id="hledani-knihovna"
          ref={inputRef}
          name="q"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Hledat problém nebo kód MKN-10"
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          // Prohlížeč kreslí do pole typu search vlastní křížek. Zdejší je
          // dost velký na dotek, takže ten systémový jen překáží.
          className="pr-14 [&::-webkit-search-cancel-button]:appearance-none"
        />

        {query ? (
          <button
            type="button"
            onClick={clearSearch}
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

      <Button type="submit" variant="vedlejsi">
        Hledat
      </Button>
    </form>
  )
}
