'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, canManageLibrary, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'
import type { ActiveSession } from '@/lib/session'

/**
 * Dokumenty jednoho problému – přejmenování, pořadí, archivace.
 *
 * Nahrávání souboru tady schválně NENÍ. Server Actions mají výchozí strop těla
 * 1 MB a jeho překročení se vyhodí ještě před spuštěním funkce, takže se nedá
 * nahradit srozumitelnou hláškou. Soubory proto chodí na
 * POST /api/knihovna/nahrat.
 *
 * Problém se nikdy nebere z formuláře ani z adresy – zjišťuje se z dokumentu,
 * který akce opravdu našla ve vlastní ordinaci. Cesta pro revalidatePath() tak
 * odpovídá skutečnosti, ne tomu, co poslal prohlížeč.
 */

const CHYBA_CIZI_PUVOD = 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.'
const CHYBA_OPRAVNENI = 'Knihovnu smí měnit jen lékař nebo správce ordinace.'
const CHYBA_NEZNAMY_DOKUMENT = 'Takový dokument v této ordinaci není.'

/**
 * Ověření původu a oprávnění pro akce, které vracejí stav do formuláře.
 *
 * requireUser() stojí ZÁMĚRNĚ mimo try/catch – uvnitř může zavolat redirect()
 * a ten pracuje s výjimkou, kterou nesmí nikdo odchytit.
 */
async function overitPristup(): Promise<{ session: ActiveSession } | { chyba: string }> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { chyba: CHYBA_CIZI_PUVOD }
    throw error
  }

  const session = await requireUser()
  if (!canManageLibrary(session.user)) return { chyba: CHYBA_OPRAVNENI }

  return { session }
}

/** Totéž pro akce bez návratového stavu. Nemají kam odpovědět, takže vyhazují. */
async function vyzadatSpravceKnihovny(): Promise<ActiveSession> {
  await requireTrustedOrigin()

  const session = await requireUser()
  if (!canManageLibrary(session.user)) throw new ForbiddenError(CHYBA_OPRAVNENI)

  return session
}

// ---------------------------------------------------------------------------
// Přejmenování dokumentu
// ---------------------------------------------------------------------------

const PrejmenovaniSchema = z.object({
  documentId: z.uuid({ error: 'Neplatný dokument.' }),
  nazev: z
    .string({ error: 'Zadejte název dokumentu.' })
    .trim()
    .min(1, { error: 'Zadejte název dokumentu.' })
    .max(200, { error: 'Název může mít nejvýše 200 znaků.' }),
})

export type RenameDocumentState = {
  error?: string
  fieldErrors?: { nazev?: string[] }
  saved?: boolean
}

export async function renameDocument(
  _prev: RenameDocumentState,
  formData: FormData,
): Promise<RenameDocumentState> {
  const pristup = await overitPristup()
  if ('chyba' in pristup) return { error: pristup.chyba }
  const { session } = pristup

  const parsed = PrejmenovaniSchema.safeParse({
    documentId: formData.get('documentId'),
    nazev: formData.get('nazev'),
  })
  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    // Vadné id dokumentu není chyba vyplnění – uživatel se na to pole nedostal.
    if (tree.properties?.documentId?.errors?.length) return { error: CHYBA_NEZNAMY_DOKUMENT }
    return { fieldErrors: { nazev: tree.properties?.nazev?.errors } }
  }

  const { documentId, nazev } = parsed.data
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const vysledek = await withPractice(practiceId, async (db) => {
    // Řádek cizí ordinace politika RLS nevrátí, takže null znamená „cizí nebo
    // neexistující dokument". Bez téhle kontroly by zápis mimo ordinaci
    // proběhl mlčky – netrefil by nic a tvářil by se jako úspěch.
    const dokument = await db.templateDocument.findUnique({
      where: { id: documentId },
      select: { title: true, problemId: true },
    })
    if (!dokument) return null

    // Odeslání beze změny se nemá objevit v deníku jako úprava.
    if (dokument.title === nazev) return { problemId: dokument.problemId }

    await db.templateDocument.update({ where: { id: documentId }, data: { title: nazev } })

    await writeAudit(db, practiceId, {
      action: 'PROBLEM_UPDATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      documentId,
      metadata: {
        akce: 'prejmenovani',
        documentId,
        problemId: dokument.problemId,
        z: dokument.title,
        na: nazev,
      },
      context,
    })

    return { problemId: dokument.problemId }
  })

  if (!vysledek) return { error: CHYBA_NEZNAMY_DOKUMENT }

  revalidatePath(`/knihovna/${vysledek.problemId}`)

  return { saved: true }
}

// ---------------------------------------------------------------------------
// Pořadí dokumentů
// ---------------------------------------------------------------------------

const PresunSchema = z.object({
  documentId: z.uuid({ error: 'Neplatný dokument.' }),
  smer: z.enum(['nahoru', 'dolu'], { error: 'Neplatný směr.' }),
})

export async function moveDocument(formData: FormData): Promise<void> {
  const session = await vyzadatSpravceKnihovny()

  const parsed = PresunSchema.safeParse({
    documentId: formData.get('documentId'),
    smer: formData.get('smer'),
  })
  if (!parsed.success) throw new ForbiddenError('Neplatný požadavek na změnu pořadí.')

  const { documentId, smer } = parsed.data
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const vysledek = await withPractice(practiceId, async (db) => {
    const dokument = await db.templateDocument.findUnique({
      where: { id: documentId },
      select: { title: true, problemId: true, archivedAt: true },
    })
    if (!dokument) return { stav: 'nenalezeno' as const }
    // Archivovaný dokument v seznamu nestojí, takže nemá kam jít.
    if (dokument.archivedAt) return { stav: 'nelze' as const }

    /*
     * Souběh dvou lidí u jednoho problému.
     *
     * FOR UPDATE zamkne celou skupinu sourozenců, takže druhý přesun počká a
     * pak počítá z čísel, která už platí. Bez zámku by oba načetli stejný stav
     * a ten, kdo zapíše druhý, by přepsal cizí výsledek starými čísly.
     *
     * Dotaz je syrový kvůli FOR UPDATE, které Prisma nevyjádří. Oddělení
     * ordinací to neoslabuje – politika RLS platí i pro syrové dotazy uvnitř
     * withPractice(), takže filtr na ordinaci tu schválně není.
     */
    const sourozenci = await db.$queryRaw<{ id: string; sortOrder: number }[]>`
      SELECT id, sort_order AS "sortOrder"
        FROM template_document
       WHERE problem_id = ${dokument.problemId}::uuid
         AND archived_at IS NULL
       ORDER BY sort_order ASC, id ASC
       FOR UPDATE
    `

    const pozice = sourozenci.findIndex((radek) => radek.id === documentId)
    // Mezitím ho někdo archivoval nebo smazal.
    if (pozice === -1) return { stav: 'nenalezeno' as const }

    const cilovaPozice = smer === 'nahoru' ? pozice - 1 : pozice + 1
    // Krajní dokument nemá souseda. Není to chyba, jen se nic nestane.
    if (cilovaPozice < 0 || cilovaPozice >= sourozenci.length) return { stav: 'kraj' as const }

    const presouvany = sourozenci[pozice]
    const soused = sourozenci[cilovaPozice]
    if (!presouvany || !soused) return { stav: 'nenalezeno' as const }

    const nove = sourozenci.map((radek, index) => {
      if (index === pozice) return soused
      if (index === cilovaPozice) return presouvany
      return radek
    })

    /*
     * Přečísluje se celý seznam, ne jen prohodí dvě čísla.
     *
     * Dvě souběžná nahrání mohou dvěma dokumentům přidělit stejné sort_order –
     * výpočet „nejvyšší + 1" běží nad snímkem, který mezitím zestárne. Prosté
     * prohození dvou stejných čísel by pořadím nehnulo a tlačítko by se tvářilo
     * jako rozbité. Řádky jsou v tuhle chvíli zamčené, takže je přepis bezpečný.
     */
    for (const [index, radek] of nove.entries()) {
      const novePoradi = index + 1
      if (radek.sortOrder === novePoradi) continue

      const { count } = await db.templateDocument.updateMany({
        where: { id: radek.id },
        data: { sortOrder: novePoradi },
      })
      // Nula dotčených řádků znamená, že zápis nic netrefil. Výjimka je tu
      // proti návratové hodnotě navíc: vrátí zpátky i čísla přepsaná před ní,
      // takže pořadí nezůstane rozpůlené uprostřed přečíslování.
      if (count === 0) throw new ForbiddenError(CHYBA_NEZNAMY_DOKUMENT)
    }

    await writeAudit(db, practiceId, {
      action: 'PROBLEM_UPDATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      documentId,
      metadata: {
        akce: 'presun',
        documentId,
        problemId: dokument.problemId,
        nazev: dokument.title,
        smer,
        z: pozice + 1,
        na: cilovaPozice + 1,
      },
      context,
    })

    return { stav: 'presunuto' as const, problemId: dokument.problemId }
  })

  if (vysledek.stav === 'nenalezeno') throw new ForbiddenError(CHYBA_NEZNAMY_DOKUMENT)
  if (vysledek.stav === 'nelze') {
    throw new ForbiddenError('Archivovaný dokument nemá v pořadí co dělat.')
  }
  // Na kraji seznamu se nic nezměnilo, není co obnovovat.
  if (vysledek.stav === 'kraj') return

  revalidatePath(`/knihovna/${vysledek.problemId}`)
}

// ---------------------------------------------------------------------------
// Archivace a obnovení dokumentu
// ---------------------------------------------------------------------------

const ArchivaceSchema = z.object({
  documentId: z.uuid({ error: 'Neplatný dokument.' }),
  archivovat: z.enum(['ano', 'ne'], { error: 'Neplatný požadavek.' }),
})

export async function setDocumentArchived(formData: FormData): Promise<void> {
  const session = await vyzadatSpravceKnihovny()

  const parsed = ArchivaceSchema.safeParse({
    documentId: formData.get('documentId'),
    archivovat: formData.get('archivovat'),
  })
  if (!parsed.success) throw new ForbiddenError('Neplatný požadavek na archivaci dokumentu.')

  const { documentId } = parsed.data
  const archivovat = parsed.data.archivovat === 'ano'
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const cil = await withPractice(practiceId, async (db) => {
    const dokument = await db.templateDocument.findUnique({
      where: { id: documentId },
      select: { title: true, problemId: true, archivedAt: true },
    })
    if (!dokument) return null

    await db.templateDocument.update({
      where: { id: documentId },
      data: {
        // Dvojí kliknutí na „Archivovat" nemá přepsat datum, kdy se to stalo
        // poprvé.
        archivedAt: archivovat ? (dokument.archivedAt ?? new Date()) : null,
      },
    })

    await writeAudit(db, practiceId, {
      action: 'TEMPLATE_ARCHIVED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      documentId,
      metadata: {
        documentId,
        problemId: dokument.problemId,
        nazev: dokument.title,
        archivovano: archivovat,
      },
      context,
    })

    return dokument
  })

  if (!cil) throw new ForbiddenError(CHYBA_NEZNAMY_DOKUMENT)

  // Seznam problémů ukazuje počet živých dokumentů, takže se mění i on.
  revalidatePath('/knihovna')
  revalidatePath(`/knihovna/${cil.problemId}`)
}
