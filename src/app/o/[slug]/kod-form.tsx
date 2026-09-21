'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { Button, Input } from '@/components/ui'
import { claimCode } from './actions'

/**
 * Zadání kódu z obrazovky u lékaře.
 *
 * Pacient sem přišel právě kvůli tomuhle poli, takže je v něm rovnou kurzor –
 * jinde v aplikaci by automatické zaměření spíš překáželo.
 *
 * Odeslání po čtvrté číslici je jen vylepšení pro prohlížeč se skriptem.
 * Formulář zůstává obyčejný: bez JavaScriptu ho odešle tlačítko a neúplný kód
 * zachytí atributy required a pattern přímo v prohlížeči.
 */

const DELKA_KODU = 4

export function KodForm({ slug, tagSecret }: { slug: string; tagSecret: string }) {
  const [state, formAction, isPending] = useActionState(claimCode, {})
  const [kod, setKod] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const odeslanyKod = useRef<string | null>(null)

  useEffect(() => {
    if (isPending || kod.length !== DELKA_KODU) return
    // Bez téhle pojistky by se stejný kód po dokončení akce odeslal znovu.
    if (odeslanyKod.current === kod) return
    odeslanyKod.current = kod
    formRef.current?.requestSubmit()
  }, [kod, isPending])

  useEffect(() => {
    if (!state.error) return
    // Po nezdaru je v poli špatné číslo. Vymazat ho za pacienta je rychlejší
    // než čtyřikrát mazat na dotykové klávesnici.
    setKod('')
    odeslanyKod.current = null
    inputRef.current?.focus()
  }, [state])

  return (
    <form ref={formRef} action={formAction} className="space-y-7">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="tagSecret" value={tagSecret} />

      {state.error ? (
        // Alert ze sdílených prvků je psaný pro obrazovku lékaře a má malé
        // písmo. Pacient čte na telefonu v ruce a často ve spěchu, proto tady
        // chyba vypadá jinak než ve zbytku aplikace.
        <p
          role="alert"
          className="rounded-2xl border-2 border-chyba/40 bg-chyba/5 px-5 py-4 text-xl leading-relaxed font-medium text-chyba"
        >
          {state.error}
        </p>
      ) : null}

      <div>
        <label htmlFor="kod" className="block text-xl font-medium">
          Kód z obrazovky u lékaře
        </label>
        <span id="napoveda-kod" className="mt-1 block text-lg text-text-tlumeny">
          Čtyři číslice
        </span>

        <Input
          ref={inputRef}
          id="kod"
          name="kod"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={DELKA_KODU}
          pattern="[0-9]{4}"
          autoFocus
          required
          spellCheck={false}
          aria-describedby="napoveda-kod"
          aria-invalid={state.error ? true : undefined}
          value={kod}
          onChange={(event) => setKod(event.target.value.replace(/\D/g, '').slice(0, DELKA_KODU))}
          // Odsazení vyrovnává mezeru, kterou rozestup přidává za poslední
          // číslici. Vykřičník u velikosti písma je nutný: Tailwind řadí
          // utility stejné vlastnosti podle abecedy, takže text-base ze
          // sdíleného pole by jinak vyhrálo nad text-5xl bez ohledu na pořadí.
          className="mt-3 py-5 text-center text-5xl! font-semibold tracking-[0.4em] indent-[0.4em]"
        />
      </div>

      <Button type="submit" size="velke" className="w-full" disabled={isPending}>
        {isPending ? 'Otevírám dokumenty…' : 'Zobrazit dokumenty'}
      </Button>
    </form>
  )
}
