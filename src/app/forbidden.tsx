import Link from 'next/link'

import { Button, CenteredPage } from '@/components/ui'

/**
 * Stránka pro odepřený přístup (stav 403).
 *
 * Vykresluje se na serveru, takže hláška dorazí i uživateli bez JavaScriptu –
 * na rozdíl od chybové hranice v error.tsx, která je klientská.
 */
export default function Forbidden() {
  return (
    <CenteredPage title="Sem nemáte přístup">
      <p className="text-text-tlumeny">
        K této části aplikace nemá vaše role oprávnění. Potřebujete-li se sem dostat, řekněte si
        správci ordinace.
      </p>

      <div className="mt-6">
        <Link href="/">
          <Button type="button" variant="vedlejsi">
            Zpět na přehled
          </Button>
        </Link>
      </div>
    </CenteredPage>
  )
}
