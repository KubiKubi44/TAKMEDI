import type { Metadata } from 'next'
import Link from 'next/link'

import type { Role } from '@/generated/prisma/enums'
import { Button, Card } from '@/components/ui'
import { Hlavicka } from '@/components/hlavicka'
import { requireRole } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { OrdinaceForm, StavUzivateleForm, UzivatelForm } from './uzivatel-form'

/**
 * Nastavení ordinace a správa uživatelů.
 *
 * Oprávnění se ověřuje tady, ne v layoutu. Layout se při navigaci mezi
 * stránkami znovu nevykresluje a hlavně nerozhoduje o tom, jestli se zbytek
 * cesty vykreslí – bezpečnostní hranicí je stránka a Server Action.
 */

export const metadata: Metadata = {
  title: 'Nastavení – MedPředání',
}

const NAZVY_ROLI: Record<Role, string> = {
  DOCTOR: 'Lékař',
  NURSE: 'Sestra',
  PRACTICE_ADMIN: 'Admin ordinace',
}

/**
 * Časová zóna se uvádí výslovně. Server běží v UTC a bez ní by se čas
 * posledního přihlášení lišil od toho, co má obsluha na hodinách.
 */
const FORMAT_DATA = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
})

export default async function NastaveniPage() {
  const session = await requireRole('PRACTICE_ADMIN')
  const practiceId = session.user.practiceId

  // Výčet sloupců je napsaný ručně, takže se do stránky nemůže dostat hash
  // hesla ani tajemství druhého faktoru. Pozdější přidání citlivého sloupce
  // do modelu sem samo nepropadne.
  const { users, practice } = await withPractice(practiceId, async (db) => ({
    users: await db.user.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        roles: true,
        status: true,
        lastLoginAt: true,
        totpConfirmedAt: true,
      },
    }),
    practice: await db.practice.findUniqueOrThrow({
      where: { id: practiceId },
      select: {
        name: true,
        addressLine: true,
        linkTtlDays: true,
        handoffTtlSeconds: true,
        sessionIdleMinutes: true,
      },
    }),
  }))

  return (
    <>
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin
      />
      <main className="mx-auto max-w-5xl space-y-10 p-6 sm:p-8">
      <header>
        <p className="text-sm text-text-tlumeny">{session.practice.name}</p>
        <h1 className="text-2xl font-semibold">Nastavení</h1>
        <p className="mt-1 text-text-tlumeny">
          Uživatelé a chování ordinace. Tuhle část vidí jen admin ordinace.
        </p>
      </header>

      <nav aria-label="Další nastavení" className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/nastaveni/cip"
          className="flex min-h-16 flex-col justify-center rounded-xl border-2 border-obrys bg-plocha px-5 py-3 transition-colors hover:border-hlavni"
        >
          <span className="font-semibold">NFC čip</span>
          <span className="text-sm text-text-tlumeny">Adresa k zápisu na čip a návod.</span>
        </Link>
        <Link
          href="/nastaveni/audit"
          className="flex min-h-16 flex-col justify-center rounded-xl border-2 border-obrys bg-plocha px-5 py-3 transition-colors hover:border-hlavni"
        >
          <span className="font-semibold">Auditní deník</span>
          <span className="text-sm text-text-tlumeny">Kdo co udělal, včetně přístupů pacientů.</span>
        </Link>
      </nav>

      <section aria-labelledby="nadpis-uzivatele" className="space-y-4">
        <h2 id="nadpis-uzivatele" className="text-xl font-semibold">
          Uživatelé
        </h2>

        {/* Rámeček se kreslí ručně, ne přes Card – tabulka potřebuje
            odsazení uvnitř buněk, ne kolem celé karty. */}
        <div className="overflow-x-auto rounded-2xl border border-obrys bg-plocha shadow-sm">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Uživatelé ordinace a jejich stav</caption>
            <thead>
              <tr className="border-b border-obrys text-text-tlumeny">
                <th scope="col" className="px-5 py-3 font-medium">
                  Jméno
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  E-mail
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Role
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Stav
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Poslední přihlášení
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Dvoufázové ověření
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  <span className="sr-only">Akce</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const jaSam = user.id === session.userId
                const zablokovany = user.status === 'DISABLED'

                return (
                  <tr key={user.id} className="border-b border-obrys last:border-b-0">
                    <th scope="row" className="px-5 py-4 text-left font-medium">
                      {user.name}
                      {jaSam ? (
                        <span className="ml-2 font-normal text-text-tlumeny">(vy)</span>
                      ) : null}
                    </th>
                    <td className="px-5 py-4 text-text-tlumeny">{user.email}</td>
                    <td className="px-5 py-4">
                      {user.roles.map((role) => NAZVY_ROLI[role]).join(', ')}
                    </td>
                    <td className="px-5 py-4">
                      <span className={zablokovany ? 'text-chyba' : 'text-uspech'}>
                        {zablokovany ? 'Zablokovaný' : 'Aktivní'}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-text-tlumeny">
                      {user.lastLoginAt ? FORMAT_DATA.format(user.lastLoginAt) : 'Zatím nikdy'}
                    </td>
                    <td className="px-5 py-4">
                      {user.totpConfirmedAt ? (
                        'Nastavené'
                      ) : (
                        <span className="text-varovani">Chybí</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right">
                      {jaSam ? (
                        // Vlastní účet zablokovat nejde. Server to odmítne
                        // i tak – tady jen nemá smysl nabízet, co neprojde.
                        <span className="text-text-tlumeny">—</span>
                      ) : (
                        <StavUzivateleForm
                          userId={user.id}
                          userName={user.name}
                          zablokovany={zablokovany}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="text-sm text-text-tlumeny">
          Zablokování platí okamžitě: účet se zároveň odhlásí ze všech zařízení, na kterých je
          zrovna přihlášený.
        </p>
      </section>

      <section aria-labelledby="nadpis-novy" className="space-y-4">
        <h2 id="nadpis-novy" className="text-xl font-semibold">
          Nový uživatel
        </h2>
        <Card>
          <UzivatelForm />
        </Card>
      </section>

      <section aria-labelledby="nadpis-ordinace" className="space-y-4">
        <h2 id="nadpis-ordinace" className="text-xl font-semibold">
          Ordinace
        </h2>
        <Card>
          <OrdinaceForm vychozi={practice} />
        </Card>
      </section>
    </main>
    </>
  )
}
