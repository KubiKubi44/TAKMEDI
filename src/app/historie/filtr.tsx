'use client'

import Link from 'next/link'
import { useState } from 'react'

import { Button, Field, Input } from '@/components/ui'

/**
 * Filtr historie předání.
 *
 * Formulář odesílá metodou GET přímo na /historie, takže filtrování funguje
 * i bez JavaScriptu, dá se poslat odkazem a nese ho tlačítko zpět. Výběry
 * dostává komponenta hotové z serveru jako prostá pole – žádný dotaz do
 * databáze odsud nevede a do prohlížeče se nedostane nic než název a id.
 *
 * Stav v komponentě slouží jedinému účelu: pole s daty si navzájem omezují
 * rozsah, aby lékař ve spěchu nezadal období pozpátku a nedíval se pak na
 * prázdnou tabulku.
 */

export type Volba = { id: string; label: string }

export type FiltrHodnoty = {
  od: string
  do: string
  problemId: string
  createdById: string
}

/** Stejný tvar jako Input z ui.tsx – <select> se ve sdílených prvcích nenachází. */
const VYBER =
  'block w-full min-h-12 rounded-xl border-2 border-obrys bg-plocha px-4 py-3 text-base outline-none focus:border-hlavni'

export function Filtr({
  problemy,
  uzivatele,
  hodnoty,
  dnes,
}: {
  problemy: Volba[]
  uzivatele: Volba[]
  /** Co je právě v adrese. Slouží jako výchozí obsah polí. */
  hodnoty: FiltrHodnoty
  /** Dnešek v pražském čase jako 2026-09-17. Strop polí s datem – historie do budoucna nesahá. */
  dnes: string
}) {
  const [od, setOd] = useState(hodnoty.od)
  const [doKdy, setDoKdy] = useState(hodnoty.do)

  const filtrujeSe = Boolean(
    hodnoty.od || hodnoty.do || hodnoty.problemId || hodnoty.createdById,
  )

  // Tvar 2026-09-17 se dá porovnat jako text, dřívější datum je vždy menší.
  const obraceneObdobi = od !== '' && doKdy !== '' && od > doKdy

  return (
    <form
      method="get"
      action="/historie"
      aria-labelledby="nadpis-filtr"
      aria-describedby="filtr-vysvetleni"
      className="rounded-2xl border border-obrys bg-plocha p-5 shadow-sm sm:p-6"
    >
      <h2 id="nadpis-filtr" className="sr-only">
        Filtr historie
      </h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Od">
          <Input
            type="date"
            name="od"
            value={od}
            onChange={(event) => setOd(event.target.value)}
            max={doKdy || dnes}
          />
        </Field>

        <Field label="Do">
          <Input
            type="date"
            name="do"
            value={doKdy}
            onChange={(event) => setDoKdy(event.target.value)}
            min={od || undefined}
            max={dnes}
          />
        </Field>

        <Field label="Problém">
          <select name="problemId" defaultValue={hodnoty.problemId} className={VYBER}>
            <option value="">Všechny problémy</option>
            {problemy.map((problem) => (
              <option key={problem.id} value={problem.id}>
                {problem.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Kdo předal">
          <select name="createdById" defaultValue={hodnoty.createdById} className={VYBER}>
            <option value="">Kdokoli z ordinace</option>
            {uzivatele.map((uzivatel) => (
              <option key={uzivatel.id} value={uzivatel.id}>
                {uzivatel.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {obraceneObdobi ? (
        <p role="alert" className="mt-4 text-sm text-chyba">
          Datum „do“ je dřív než „od“. Prohoďte je prosím, jinak se nenajde nic.
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button type="submit" variant="vedlejsi">
          Filtrovat
        </Button>

        {filtrujeSe ? (
          // Odkaz, ne tlačítko: je to návrat na nefiltrovanou stránku, takže má
          // fungovat i prostřední tlačítko myši a otevření na nové kartě.
          <Link
            href="/historie"
            className="inline-flex min-h-12 items-center font-medium text-text-tlumeny underline underline-offset-4 hover:text-hlavni"
          >
            Zrušit filtr
          </Link>
        ) : null}
      </div>

      <p id="filtr-vysvetleni" className="mt-4 max-w-3xl text-sm text-text-tlumeny">
        Podle jména pacienta hledat nejde a je to záměr: označení pacienta je v databázi
        zašifrované, takže se dá jen zobrazit, ne prohledávat. Filtrujte proto podle data,
        problému nebo kolegy, který balíček předal.
      </p>
    </form>
  )
}
