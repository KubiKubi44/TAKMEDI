import type { Metadata } from 'next'
import Link from 'next/link'

import { Hlavicka } from '@/components/hlavicka'
import { Card } from '@/components/ui'
import { isPracticeAdmin, requireRole } from '@/lib/auth'
import { NovyProblemForm } from './formular'

/**
 * Založení nového problému v knihovně.
 *
 * Oprávnění se ověřuje tady a znovu v Server Action. Layout by to neuhlídal –
 * nerozhoduje o tom, jestli se zbytek cesty vykreslí.
 */

export const metadata: Metadata = {
  title: 'Nový problém – MedPředání',
}

export default async function NovyProblemPage({
  searchParams,
}: {
  searchParams: Promise<{ nazev?: string | string[] }>
}) {
  const session = await requireRole('DOCTOR', 'PRACTICE_ADMIN')

  // Předvyplnění chodí z hledání, které nic nenašlo: lékař napsal název,
  // nenašel ho a zakládá ho rovnou. Je to jen text do pole, nic se podle něj
  // nedohledává.
  const { nazev } = await searchParams
  const vychoziNazev = (Array.isArray(nazev) ? nazev[0] : nazev)?.slice(0, 200) ?? ''

  return (
    <>
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto max-w-2xl space-y-8 p-6 sm:p-8">
        <header className="space-y-2">
          <Link
            href="/knihovna"
            className="inline-flex min-h-12 items-center text-text-tlumeny underline underline-offset-4 hover:text-text"
          >
            Zpět do knihovny
          </Link>
          <h1 className="text-2xl font-semibold">Nový problém</h1>
          <p className="text-text-tlumeny">
            Problém je skupina dokumentů k jedné diagnóze nebo situaci – třeba „Po operaci
            kolene“ nebo „Warfarin“. Při přípravě balíčku pak stačí vybrat problém a jeho
            dokumenty se nabídnou samy. Dokumenty do něj přidáte hned po založení.
          </p>
        </header>

        <Card>
          <NovyProblemForm vychoziNazev={vychoziNazev} />
        </Card>
      </main>
    </>
  )
}
