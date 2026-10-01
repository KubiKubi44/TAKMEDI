import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { Alert, CenteredPage } from '@/components/ui'
import { getSession } from '@/lib/auth'
import { env } from '@/lib/env'

import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Přihlášení do MedPředání',
  robots: { index: false, follow: false },
}

export default async function LoginPage() {
  const session = await getSession()

  // Přesměrovává se jen ten, kdo má za sebou heslo i druhý faktor. Relace po
  // samotném hesle na tuhle obrazovku patří: uživatel se z ní může přihlásit
  // znovu, třeba pod jiným účtem.
  const fullySignedIn = Boolean(session?.user.totpConfirmed && session?.totpVerified)

  if (fullySignedIn) redirect('/')

  return (
    <CenteredPage title="Přihlášení do MedPředání">
      <LoginForm />
      {/*

        Vývojová zkratka. Bez DEV_LOGIN_EMAIL v prostředí se nevykreslí

        a v produkci aplikace s tou proměnnou vůbec nenastartuje.

      */}

      {env.DEV_LOGIN_EMAIL && env.NODE_ENV !== 'production' ? (

        <div className="mt-7 space-y-3 border-t border-obrys pt-5">

          <Alert tone="info">

            Vývojový režim: zkratka přihlásí {env.DEV_LOGIN_EMAIL} bez hesla a bez druhého

            faktoru. V produkci je vypnutá.

          </Alert>

          <a

            href="/api/dev/prihlasit"

            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-dashed border-obrys-silny bg-plocha px-5 font-medium text-text-tlumeny transition-colors hover:border-hlavni hover:text-hlavni-tmavy"

          >

            Přihlásit bez ověření (jen vývoj)

          </a>

        </div>

      ) : null}
    </CenteredPage>
  )
}
