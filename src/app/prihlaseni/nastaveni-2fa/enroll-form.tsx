'use client'

import { useActionState } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'
import { confirmTotpEnrollment } from '../actions'

/**
 * Potvrzení druhého faktoru prvním kódem.
 *
 * Formulář posílá JEN kód. Tajemství si server přečte z databáze, kde na něj
 * čeká jako nepotvrzené – kdyby ho přebíral odsud, mohl by si útočník, který
 * zná heslo, podstrčit vlastní a druhý faktor tím obejít.
 *
 * Uživatel, kterému se QR kód načíst nepodaří, se nezamkne: dokud tajemství
 * nepotvrdí, vrací ho přihlášení sem a uvidí pokaždé ten samý QR kód.
 */
export function EnrollForm() {
  const [state, formAction, isPending] = useActionState(confirmTotpEnrollment, {})

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <Field label="Kód z aplikace" hint="Šest číslic, mění se každých 30 sekund.">
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          aria-invalid={state.error ? true : undefined}
          className="text-center text-xl tracking-widest"
        />
      </Field>

      {state.error ? <Alert>{state.error}</Alert> : null}

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? 'Ověřuji kód…' : 'Aktivovat a přihlásit se'}
      </Button>
    </form>
  )
}
