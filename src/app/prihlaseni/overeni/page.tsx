import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { Button, CenteredPage } from '@/components/ui'
import { requireHalfSession } from '@/lib/auth'
import { logout } from '../actions'
import { TotpForm } from './totp-form'

export const metadata: Metadata = {
  title: 'Ověření přihlášení',
}

/**
 * Druhý faktor. Kontrola stojí ve stránce, ne v layoutu – layout o vykreslení
 * ostatních segmentů nerozhoduje, a tedy není bezpečnostní hranicí.
 */
export default async function OvereniPage() {
  const session = await requireHalfSession()

  if (session.totpVerified) redirect('/')
  if (!session.user.totpConfirmed) redirect('/prihlaseni/nastaveni-2fa')

  return (
    <CenteredPage title="Ověření přihlášení">
      <p className="mb-5 text-text-tlumeny">
        Otevřete v telefonu ověřovací aplikaci (Google Authenticator nebo podobnou) a opište
        šestimístný kód pro účet <span className="text-text">{session.user.email}</span>.
      </p>

      <TotpForm />

      <p className="mt-6 text-sm text-text-tlumeny">
        Ztratili jste telefon s ověřovací aplikací? Druhý faktor vám zruší správce ordinace –
        bez něj se přihlásit nelze.
      </p>

      <form action={logout} className="mt-6 border-t border-obrys pt-4 text-center">
        <Button type="submit" variant="nenapadny">
          Přihlásit se jiným účtem
        </Button>
      </form>
    </CenteredPage>
  )
}
