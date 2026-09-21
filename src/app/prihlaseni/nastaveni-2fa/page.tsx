import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { CenteredPage } from '@/components/ui'
import { requireHalfSession } from '@/lib/auth'
import { prepareTotpEnrollment } from '../actions'
import { EnrollForm } from './enroll-form'

export const metadata: Metadata = {
  title: 'Nastavení dvoufázového přihlášení',
}

/** Tajemství se opisuje ručně, po čtveřicích znaků se v něm oko neztratí. */
function formatSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ')
}

const STEPS = [
  'Nainstalujte si do telefonu aplikaci na jednorázové kódy. Zdarma jsou třeba Google Authenticator, Microsoft Authenticator nebo 2FAS.',
  'V aplikaci zvolte přidání účtu a namiřte fotoaparát telefonu na QR kód níže.',
  'Opište šestimístný kód, který se v aplikaci objeví, do pole pod QR kódem.',
]

export default async function TotpSetupPage() {
  const session = await requireHalfSession()

  // Kdo druhý faktor nastavený má, ten si ho tady nastavit znovu nesmí: výměna
  // tajemství bez znalosti toho původního by z téhle stránky udělala obchvat
  // celého druhého faktoru.
  if (session.user.totpConfirmed) redirect('/prihlaseni/overeni')

  const { qrDataUrl, secret } = await prepareTotpEnrollment()

  return (
    <CenteredPage title="Nastavení dvoufázového přihlášení">
      <p>
        V aplikaci jsou zdravotní údaje pacientů a na ty samotné heslo nestačí – kdo ho
        odkouká nebo uhodne, dostane se dovnitř místo vás. Proto se při každém přihlášení
        ptáme ještě na šestimístný kód z vašeho telefonu. Kód se každou půlminutu mění, takže
        bez telefonu v ruce se nikdo nepřihlásí.
      </p>

      <ol className="mt-6 space-y-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-obrys font-semibold"
            >
              {index + 1}
            </span>
            <span className="pt-1">{step}</span>
          </li>
        ))}
      </ol>

      {/* QR kód je data URL, next/image by na něm neměl co optimalizovat. */}
      <img
        src={qrDataUrl}
        alt="QR kód pro nastavení aplikace"
        width={256}
        height={256}
        className="mx-auto mt-6 rounded-xl border-2 border-obrys bg-white p-2"
      />

      <p className="mt-4 text-sm text-text-tlumeny">
        Když telefon QR kód nenačte, zadejte do aplikace tento kód ručně. Mezery jsou jen pro
        přehlednost, nepište je.
      </p>
      <code className="mt-2 block select-all break-words rounded-xl border border-obrys bg-podklad px-4 py-3 text-center font-mono tracking-wider">
        {formatSecret(secret)}
      </code>

      <EnrollForm />
    </CenteredPage>
  )
}
