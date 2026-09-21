import { Navigace } from '@/components/navigace'
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
    // Přilepená nahoře: obsluha se při dlouhé tabulce nemusí vracet nahoru,
    // aby přešla jinam.
    <header className="sticky top-0 z-30 border-b border-obrys bg-plocha/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-6 py-3">
        <div className="min-w-0">
          <p className="truncate text-[1.0625rem] leading-tight font-semibold">{practiceName}</p>
          <p className="popisek-udaje mt-0.5">MedPředání</p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Navigace isAdmin={isAdmin} />

          {/* Svislá linka odděluje navigaci od účtu – jsou to dvě různé věci. */}
          <span aria-hidden="true" className="hidden h-6 w-px bg-obrys sm:block" />

          <span className="truncate text-sm font-medium text-text-tlumeny">{userName}</span>
          <Odhlasit />
        </div>
      </div>
    </header>
  )
}
