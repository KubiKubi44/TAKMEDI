import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { CenteredPage } from '@/components/ui'
import { getSession } from '@/lib/auth'

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
    </CenteredPage>
  )
}
