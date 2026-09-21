'use client'

import { useActionState, useState, type ComponentProps } from 'react'
import Link from 'next/link'

import { Alert, Button, Field, Input } from '@/components/ui'
import { createProblem } from '../actions'

/**
 * Formulář nového problému.
 *
 * Pole jsou řízená schválně. React po doběhnutí akce formulář vyprázdní, takže
 * po zamítnuté kontrole na serveru by lékař psal název i poznámku znovu.
 */
export function NovyProblemForm({ vychoziNazev = '' }: { vychoziNazev?: string }) {
  const [state, action, isPending] = useActionState(createProblem, {})

  const [nazev, setNazev] = useState(vychoziNazev)
  const [icd10, setIcd10] = useState('')
  const [poznamka, setPoznamka] = useState('')

  return (
    <form action={action} className="space-y-5">
      {state.error ? <Alert tone="chyba">{state.error}</Alert> : null}

      <Field
        label="Název"
        hint="Jak problém poznáte v seznamu. Například „Po operaci kolene“."
        errors={state.fieldErrors?.nazev}
      >
        <Input
          name="nazev"
          value={nazev}
          onChange={(event) => setNazev(event.target.value)}
          autoFocus
          required
          maxLength={200}
          autoComplete="off"
        />
      </Field>

      <Field
        label="Kód MKN-10"
        hint="Nepovinné. Například Z96.6. Podle kódu se pak problém dá najít i bez psaní názvu."
        errors={state.fieldErrors?.icd10}
      >
        <Input
          name="icd10"
          value={icd10}
          onChange={(event) => setIcd10(event.target.value)}
          maxLength={16}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="Z96.6"
        />
      </Field>

      <Field
        label="Poznámka"
        hint="Nepovinné. Krátká připomínka pro vás a kolegy, pacient ji nevidí."
        errors={state.fieldErrors?.poznamka}
      >
        <Textarea
          name="poznamka"
          value={poznamka}
          onChange={(event) => setPoznamka(event.target.value)}
          rows={3}
          maxLength={500}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Zakládám…' : 'Založit problém'}
        </Button>
        <Link
          href="/knihovna"
          className="inline-flex min-h-12 items-center text-text-tlumeny underline underline-offset-4 hover:text-text"
        >
          Zrušit
        </Link>
      </div>
    </form>
  )
}

/** Víceřádkové pole. V src/components/ui.tsx zatím není, vzhled se řídí Input. */
function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={[
        'block w-full rounded-xl border-2 border-obrys bg-plocha px-4 py-3',
        'text-base outline-none focus:border-hlavni',
        className ?? '',
      ].join(' ')}
    />
  )
}
