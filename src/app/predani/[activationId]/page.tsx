import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { Hlavicka } from '@/components/hlavicka'
import { isPracticeAdmin, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { getActivationStatus } from '@/lib/handoff'
import { Kod } from './kod'

/**
 * Obrazovka předání: kód, odpočet a čekání na pacienta.
 *
 * Ze serveru sem jde VŠECHNO KROMĚ KÓDU. Ten v databázi není – je v ní jen
 * jeho HMAC s pepperem – a v čitelné podobě vzniká jedinkrát, v odpovědi na
 * aktivaci. Stránka tedy sama o sobě kód ukázat neumí a ani nemá: vyzvedne si
 * ho komponenta Kod z jednorázového předání při navigaci (viz predejKod
 * v kod.tsx), a když není co vyzvednout, ukáže se stav bez kódu. To je mimo
 * jiné případ obnovené stránky – kód je tehdy nenávratně pryč a obrazovka
 * to řekne rovnou, místo aby lékaře nechala čekat na něco, co nepřijde.
 *
 * Kontrola přihlášení sedí tady, ne v layoutu: layout se při navigaci
 * nevykresluje znovu a nerozhoduje o tom, jestli se zbytek cesty spočítá.
 * Bezpečnostní hranicí je stránka.
 */

export const metadata: Metadata = {
  title: 'Předání pacientovi – MedPředání',
}

/** Nesmysl v adrese má skončit stránkou 404, ne chybou z databáze. */
const TVAR_ID = /^[0-9a-f-]{36}$/i

export default async function PredaniPage({
  params,
}: {
  params: Promise<{ activationId: string }>
}) {
  const session = await requireUser()
  const { activationId } = await params

  if (!TVAR_ID.test(activationId)) notFound()

  // Ordinace se bere ze session, nikdy z adresy. Aktivaci cizí ordinace
  // politika RLS nevrátí, takže null znamená „neexistuje, nebo není naše“ –
  // a obojí navenek vypadá stejně.
  const stav = await withPractice(session.user.practiceId, (db) =>
    getActivationStatus(db, activationId),
  )

  if (!stav) notFound()

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-3xl px-6 py-8 sm:py-10">
        <Kod
          activationId={activationId}
          expiresAt={stav.expiresAt.toISOString()}
          stav={stav.status}
          /* Počet pokusů je známý hned; bez něj by se zpráva o špatně zadaném
             kódu objevila až po prvním dotazu, tedy o dvě sekundy později. */
          pokusuZbyva={stav.attemptsLeft}
        />
      </main>
    </div>
  )
}
