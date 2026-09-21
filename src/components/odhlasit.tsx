import { logout } from '@/app/prihlaseni/actions'
import { Button } from '@/components/ui'

/**
 * Odhlášení je formulář, ne odkaz.
 *
 * Odkaz na odhlášení by šlo vyvolat cizí stránkou (obrázkem, iframem) nebo
 * předběžným načtením v prohlížeči, a uživatel by o relaci přišel bez svého
 * přičinění. POST z formuláře tohle nedokáže – a sama akce logout() si navíc
 * ověřuje původ požadavku.
 *
 * Soubor schválně nemá 'use client': Server Action se dá předat do
 * <form action={...}> i ze serverové komponenty. Do prohlížeče se tak
 * neposílá žádný JavaScript navíc a odhlášení funguje i bez něj.
 */
export function Odhlasit() {
  return (
    <form action={logout}>
      <Button type="submit" variant="nenapadny">
        Odhlásit se
      </Button>
    </form>
  )
}
