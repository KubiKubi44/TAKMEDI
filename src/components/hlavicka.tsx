import Link from 'next/link'

import { Odhlasit } from '@/components/odhlasit'

/**
 * Hlavička přihlášené části aplikace.
 *
 * Props jsou schválně jen tři jednoduché hodnoty, ne session ani uživatel
 * z databáze. Kdyby se sem předal celý objekt, putoval by do RSC payloadu
 * i s hashem hesla a tajemstvím druhého faktoru – a ten je v prohlížeči
 * čitelný, i když se nikde nevykreslí.
 */
export function Hlavicka({
  userName,
  practiceName,
  isAdmin,
}: {
  userName: string
  practiceName: string
  isAdmin: boolean
}) {
  return (
    <header className="border-b border-obrys bg-plocha">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-6 py-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold leading-tight">{practiceName}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-text-tlumeny">
            MedPředání
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <nav aria-label="Hlavní nabídka" className="flex items-center gap-x-1">
            {/* Knihovnu vidí i sestra: dokumenty si prohlédne a použije
                při přípravě balíčku, jen je nesmí měnit. */}
            <Link
              href="/knihovna"
              className="inline-flex min-h-12 items-center rounded-xl px-3 font-medium transition-colors hover:bg-podklad hover:text-hlavni"
            >
              Knihovna
            </Link>
            <Link
              href="/historie"
              className="inline-flex min-h-12 items-center rounded-xl px-3 font-medium transition-colors hover:bg-podklad hover:text-hlavni"
            >
              Historie
            </Link>
            {isAdmin ? (
              <Link
                href="/nastaveni"
                className="inline-flex min-h-12 items-center rounded-xl px-3 font-medium transition-colors hover:bg-podklad hover:text-hlavni"
              >
                Nastavení
              </Link>
            ) : null}
          </nav>

          <span className="truncate font-medium text-text-tlumeny">{userName}</span>
          <Odhlasit />
        </div>
      </div>
    </header>
  )
}
