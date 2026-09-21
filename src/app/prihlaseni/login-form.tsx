'use client'

import { useActionState } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'

import { login, type LoginState } from './actions'

const INITIAL_STATE: LoginState = {}

/**
 * Formulář odesílá Server Action přímo přes atribut action, takže funguje
 * i bez JavaScriptu. Hodnota isPending pak jen zpřesňuje chování v prohlížeči,
 * nic se na ní nestaví.
 */
export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, INITIAL_STATE)

  const emailErrors = state.fieldErrors?.email
  const passwordErrors = state.fieldErrors?.password

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="chyba">{state.error}</Alert> : null}

      <Field label="E-mail" errors={emailErrors}>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          autoFocus
          required
          aria-invalid={emailErrors?.length ? true : undefined}
        />
      </Field>

      <Field label="Heslo" errors={passwordErrors}>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          aria-invalid={passwordErrors?.length ? true : undefined}
        />
      </Field>

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? 'Přihlašuji…' : 'Přihlásit se'}
      </Button>

      <p className="text-sm text-text-tlumeny">
        Po zadání hesla vás požádáme ještě o šestimístný kód z ověřovací aplikace v telefonu.
      </p>

      <p className="text-center text-sm text-text-tlumeny">
        Zapomenuté heslo vám nastaví nové správce ordinace. Aplikace hesla neposílá e-mailem.
      </p>
    </form>
  )
}
