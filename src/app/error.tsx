'use client'

import { useEffect } from 'react'
import Link from 'next/link'

import { Button, CenteredPage } from '@/components/ui'

/**
 * Chybová obrazovka.
 *
 * Bez ní by Next vykreslil vlastní anglickou stránku s technickým výpisem –
 * což je pro lékaře v ordinaci k ničemu a zároveň to prozrazuje vnitřnosti
 * aplikace. Podrobnosti o chybě se proto úmyslně nezobrazují; jdou do logu
 * serveru, kam patří.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[medpredani] neošetřená chyba', error)
  }, [error])

  // Odepřený přístup je běžná situace, ne porucha – má si zasloužit vlastní
  // vysvětlení, aby uživatel nehledal chybu u sebe.
  const jeOdepreno = error.name === 'ForbiddenError'

  return (
    <CenteredPage title={jeOdepreno ? 'Sem nemáte přístup' : 'Něco se pokazilo'}>
      <p className="text-text-tlumeny">
        {jeOdepreno
          ? 'K této části aplikace nemá vaše role oprávnění. Potřebujete-li se sem dostat, řekněte si správci ordinace.'
          : 'Akci se nepodařilo dokončit. Zkuste to prosím znovu. Když se to bude opakovat, řekněte to správci ordinace.'}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        {!jeOdepreno ? (
          <Button type="button" onClick={reset}>
            Zkusit znovu
          </Button>
        ) : null}
        <Link href="/">
          <Button type="button" variant="vedlejsi">
            Zpět na přehled
          </Button>
        </Link>
      </div>

      {error.digest ? (
        <p className="mt-6 text-sm text-text-tlumeny">
          Kód chyby pro správce: <code>{error.digest}</code>
        </p>
      ) : null}
    </CenteredPage>
  )
}
