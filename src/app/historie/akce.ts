'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { ForbiddenError, requireUser } from '@/lib/auth'
import { revokePackageLinks } from '@/lib/cleanup'
import { getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Zneplatnění pacientského odkazu z historie.
 *
 * Kontrola původu stojí první: bez ní by stačilo, aby přihlášený lékař otevřel
 * cizí stránku, a ta by mu na pozadí odvolala odkaz rozdanému pacientovi.
 *
 * Ordinace se bere výhradně ze session. Z formuláře přichází jedině
 * identifikátor balíčku a ten je do chvíle, než ho najdeme ve vlastních
 * datech, pouhý text – cizí balíček politika RLS nevrátí, takže se odvolání
 * nemá čeho chytit a tiše nic neudělá. Žádné rozlišení mezi „není váš“
 * a „neexistuje“ ven nejde.
 */
export async function zneplatnitOdkaz(formData: FormData): Promise<void> {
  await requireTrustedOrigin()

  // requireUser() může přesměrovat, a to pracuje s výjimkou, kterou nesmí
  // nikdo odchytit – proto stojí mimo jakýkoli try/catch.
  const session = await requireUser()

  const packageId = z.uuid().safeParse(formData.get('packageId'))
  // Akce nemá kam vrátit stav do formuláře, takže vyhazuje. Chybová hranice
  // z toho udělá srozumitelnou stránku. forbidden() se tu nepoužívá – to patří
  // stránkám, ne akcím.
  if (!packageId.success) throw new ForbiddenError('Neplatný požadavek na zneplatnění odkazu.')

  /*
   * Návratový počet se schválně nepoužívá.
   *
   * Nula znamená, že odkaz už neplatil – vypršel, nebo ho někdo zneplatnil
   * mezitím z jiného zařízení. Výsledek je přesně ten, o který uživatel žádal,
   * takže se nemá co hlásit. Historie se překreslí a tlačítko z řádku zmizí.
   */
  await revokePackageLinks({
    practiceId: session.user.practiceId,
    packageId: packageId.data,
    userId: session.userId,
    userName: session.user.name,
    context: await getRequestContext(),
  })

  revalidatePath('/historie')
  // Detail se stejným zásahem mění taky: přibyl mu řádek auditu o odvolání.
  revalidatePath(`/historie/${packageId.data}`)
}
