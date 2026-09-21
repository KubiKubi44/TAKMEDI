'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'
import { verifyTotpCode } from '../actions'

const DELKA_KODU = 6

/**
 * Zadání kódu z ověřovací aplikace.
 *
 * Odeslání po šesté číslici je jen vylepšení pro prohlížeč se skriptem.
 * Formulář zůstává obyčejný: bez JavaScriptu ho odešle tlačítko a neúplný kód
 * zachytí atributy required a pattern přímo v prohlížeči.
 */
export function TotpForm() {
  const [state, formAction, isPending] = useActionState(verifyTotpCode, {})
  const [code, setCode] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const odeslanyKod = useRef<string | null>(null)

  useEffect(() => {
    if (isPending || code.length !== DELKA_KODU) return
    // Bez téhle pojistky by se stejný kód po dokončení akce odeslal znovu.
    if (odeslanyKod.current === code) return
    odeslanyKod.current = code
    formRef.current?.requestSubmit()
  }, [code, isPending])

  useEffect(() => {
    if (!state.error) return
    // Po nezdaru je pole k ničemu: kód v aplikaci se mezitím změnil.
    setCode('')
    odeslanyKod.current = null
    inputRef.current?.focus()
  }, [state])

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      {state.error ? <Alert tone="chyba">{state.error}</Alert> : null}

      <Field
        label="Kód z aplikace"
        hint="Šest číslic. Aplikace kód mění přibližně každých 30 sekund."
      >
        <Input
          ref={inputRef}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={DELKA_KODU}
          pattern="[0-9]{6}"
          autoFocus
          required
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          value={code}
          onChange={(event) =>
            setCode(event.target.value.replace(/\D/g, '').slice(0, DELKA_KODU))
          }
          // Odsazení vyrovnává mezeru, kterou rozestup přidává za poslední číslici.
          // Vykřičník u velikosti písma je nutný: Tailwind řadí utility stejné
          // vlastnosti podle abecedy, takže text-base ze sdíleného pole by jinak
          // vyhrálo nad text-3xl bez ohledu na pořadí tříd.
          className="py-4 text-center text-3xl! font-semibold tracking-[0.5em] indent-[0.5em]"
        />
      </Field>

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? 'Ověřuji…' : 'Ověřit'}
      </Button>
    </form>
  )
}
