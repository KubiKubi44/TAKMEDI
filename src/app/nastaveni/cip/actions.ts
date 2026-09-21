'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requireRole } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { env } from '@/lib/env'
import { createNfcTag } from '@/lib/handoff'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Správa NFC čipů ordinace.
 *
 * Obě akce jsou vyhrazené roli PRACTICE_ADMIN a obě si oprávnění ověřují samy.
 * Kontrola na stránce je pohodlí pro obsluhu, ne ochrana – Server Action se dá
 * zavolat, aniž by si útočník stránku vůbec otevřel.
 *
 * Ordinace se bere výhradně ze session. Odsud nejde poslat practiceId zvenčí,
 * takže neexistuje způsob, jak si ordinaci ve formuláři přepsat na cizí.
 */

const CHYBA_CIZI_PUVOD = 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.'

// ---------------------------------------------------------------------------
// Nový čip
// ---------------------------------------------------------------------------

export type CreateTagState = {
  error?: string
  fieldErrors?: { label?: string[] }
  /**
   * Vyplněné jen po úspěchu.
   *
   * `url` obsahuje tajemství čipu a tohle je JEDINÁ cesta, kterou se kdy
   * dostane z serveru ven – v databázi zůstane jen jeho HMAC. Znovu ho už
   * nikdo nepřečte, ani správce.
   */
  created?: { id: string; label: string; url: string }
}

const CreateTagSchema = z.object({
  label: z
    .string({ error: 'Napište, podle čeho čip poznáte.' })
    .trim()
    .min(1, { error: 'Napište, podle čeho čip poznáte. Například „Čip u recepce“.' })
    // Sloupec v databázi má 120 znaků; delší popis by zápis odmítl až na úrovni
    // databáze a uživatel by dostal pětistovku místo věty.
    .max(120, { error: 'Popis může mít nejvýše 120 znaků.' }),
})

export async function createTag(
  _prev: CreateTagState,
  formData: FormData,
): Promise<CreateTagState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  // Mimo blok try: requireRole() může přesměrovat, a přesměrování se v Next.js
  // vyhazuje jako výjimka – odchycená by se nikdy neprovedla.
  const session = await requireRole('PRACTICE_ADMIN')

  const parsed = CreateTagSchema.safeParse({ label: formData.get('label') })

  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return { fieldErrors: { label: tree.properties?.label?.errors } }
  }

  const context = await getRequestContext()

  const { tagId, url } = await createNfcTag({
    practiceId: session.user.practiceId,
    practiceSlug: session.practice.slug,
    userId: session.userId,
    userName: session.user.name,
    label: parsed.data.label,
    appUrl: env.APP_URL,
    context,
  })

  revalidatePath('/nastaveni/cip')

  return { created: { id: tagId, label: parsed.data.label, url } }
}

// ---------------------------------------------------------------------------
// Odvolání čipu
// ---------------------------------------------------------------------------

const RevokeTagSchema = z.object({
  tagId: z.uuid({ error: 'Neplatný čip.' }),
})

/**
 * Odvolá čip.
 *
 * Platí okamžitě: překlad adresy na ordinaci bere v úvahu jen čipy bez
 * revokedAt, takže po přiložení telefonu k odvolanému čipu se otevře stejná
 * stránka jako po přiložení k cizímu nebo vymyšlenému – „tahle stránka
 * neexistuje“. Nálepka se tím stává nepoužitelnou natrvalo; zamčený čip nejde
 * přepsat, takže se musí nalepit nový.
 */
export async function revokeTag(formData: FormData): Promise<void> {
  await requireTrustedOrigin()
  const session = await requireRole('PRACTICE_ADMIN')

  const parsed = RevokeTagSchema.safeParse({ tagId: formData.get('tagId') })
  if (!parsed.success) throw new ForbiddenError('Neplatný požadavek na odvolání čipu.')

  const { tagId } = parsed.data
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  await withPractice(practiceId, async (db) => {
    // Čip cizí ordinace politika RLS nevrátí, takže null znamená „cizí nebo
    // neexistující“. Už odvolaný se podruhé neodvolává – v deníku by přibyl
    // záznam o něčem, co se nestalo, a čas odvolání by se posunul.
    const tag = await db.nfcTag.findUnique({
      where: { id: tagId },
      select: { label: true, revokedAt: true },
    })
    if (!tag || tag.revokedAt) return

    await db.nfcTag.update({ where: { id: tagId }, data: { revokedAt: new Date() } })

    await writeAudit(db, practiceId, {
      action: 'NFC_TAG_REVOKED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { tagId, label: tag.label },
      context,
    })
  })

  revalidatePath('/nastaveni/cip')
}
