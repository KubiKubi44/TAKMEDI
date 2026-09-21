'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Hlavní nabídka se zvýrazněnou aktuální částí.
 *
 * Je to jediný kus hlavičky, který musí běžet v prohlížeči – potřebuje znát
 * aktuální cestu. Zbytek hlavičky zůstává serverový.
 */
export function Navigace({ isAdmin }: { isAdmin: boolean }) {
  const cesta = usePathname()

  // Knihovnu vidí i sestra: dokumenty si prohlédne a použije při přípravě
  // balíčku, jen je nesmí měnit.
  const polozky = [
    { href: '/', popisek: 'Předání' },
    { href: '/knihovna', popisek: 'Knihovna' },
    { href: '/historie', popisek: 'Historie' },
    ...(isAdmin ? [{ href: '/nastaveni', popisek: 'Nastavení' }] : []),
  ]

  return (
    <nav aria-label="Hlavní nabídka" className="flex items-center gap-x-0.5">
      {polozky.map((polozka) => {
        // Kořen se porovnává přesně, ostatní i s podstránkami – detail
        // problému má zůstat vidět jako součást knihovny.
        const aktivni =
          polozka.href === '/' ? cesta === '/' : cesta.startsWith(polozka.href)

        return (
          <Link
            key={polozka.href}
            href={polozka.href}
            aria-current={aktivni ? 'page' : undefined}
            className={[
              'relative inline-flex min-h-11 items-center rounded-lg px-3 text-[0.9375rem] font-medium transition-colors',
              aktivni
                ? 'text-hlavni-tmavy'
                : 'text-text-tlumeny hover:bg-podklad hover:text-text',
            ].join(' ')}
          >
            {polozka.popisek}
            {/* Linka pod aktivní položkou navazuje na spodní hranu hlavičky. */}
            {aktivni ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-hlavni"
              />
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
