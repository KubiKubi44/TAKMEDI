'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, canManageLibrary, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'
import type { ActiveSession } from '@/lib/session'

/**
 * Knihovna problémů – zakládání, úprava a archivace.
 *
 * Oprávnění se ověřuje tady, ne na stránce. Stránka rozhoduje o tom, co
 * uživatel VIDÍ; Server Action se ale dá zavolat i bez ní, takže kontrola na
 * stránce je pohodlí, ne ochrana.
 *
 * Odpověď na chybějící oprávnění se liší podle toho, jestli akce má kam
 * odpovědět. Akce s návratovým stavem vrátí větu do formuláře a uživatel
 * zůstane tam, kde je. Akce bez stavu (tlačítko „Archivovat") žádný takový
 * kanál nemá, proto vyhodí ForbiddenError – chybová hranice z něj udělá
 * srozumitelnou stránku. forbidden() se tu nepoužívá: ta patří stránkám,
 * ne akcím.
 *
 * Ordinace se bere výhradně ze session. Žádná zdejší akce nepřijímá
 * practiceId zvenčí.
 */

const CHYBA_CIZI_PUVOD = 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.'
const CHYBA_OPRAVNENI = 'Knihovnu smí měnit jen lékař nebo správce ordinace.'
const CHYBA_NEZNAMY_PROBLEM = 'Takový problém v této ordinaci není.'

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

/**
 * Kód MKN-10 je nepovinný a ordinace ho píše z hlavy, takže kontrola je
 * schválně mírná: přijme „I10", „Z96.6" i „Z966" (tvar bez tečky používají
 * výkazy pro NZIS). Odmítne ale text, do kterého někdo napsal název diagnózy –
 * hledání podle kódu se opírá o přesnou shodu a nesmysl v tomhle poli by se
 * nikdy netrefil.
 */
const ICD10_VZOR = /^[A-Z][0-9]{2}(\.?[0-9A-Z]{1,4})?$/

const ProblemSchema = z.object({
  nazev: z
    .string({ error: 'Zadejte název problému.' })
    .trim()
    .min(1, { error: 'Zadejte název problému.' })
    .max(200, { error: 'Název může mít nejvýše 200 znaků.' }),
  icd10: z
    .string({ error: 'Kód MKN-10 zadejte jako text.' })
    .trim()
    // Převod na velká písmena musí proběhnout PŘED kontrolou tvaru, jinak by
    // „z96.6" opsané malými písmeny neprošlo.
    .toUpperCase()
    .max(16, { error: 'Kód MKN-10 může mít nejvýše 16 znaků.' })
    .refine((hodnota) => hodnota === '' || ICD10_VZOR.test(hodnota), {
      error: 'Kód MKN-10 vypadá například jako I10 nebo Z96.6. Když ho nevíte, nechte pole prázdné.',
    })
    // Prázdné pole znamená „kód není", ne prázdný řetězec – jinak by se podle
    // něj dalo omylem hledat a v detailu by svítil prázdný řádek.
    .transform((hodnota) => (hodnota === '' ? null : hodnota)),
  poznamka: z
    .string({ error: 'Poznámku zadejte jako text.' })
    .trim()
    .max(500, { error: 'Poznámka může mít nejvýše 500 znaků.' })
    .transform((hodnota) => (hodnota === '' ? null : hodnota)),
})

function precistPoleProblemu(formData: FormData) {
  return {
    nazev: formData.get('nazev'),
    // Nevyplněné pole formulář neodešle vůbec; prázdný řetězec projde kontrolou
    // jako „nevyplněno", chybějící hodnota by hlásila špatný typ.
    icd10: formData.get('icd10') ?? '',
    poznamka: formData.get('poznamka') ?? '',
  }
}

export type ProblemState = {
  error?: string
  fieldErrors?: { nazev?: string[]; icd10?: string[]; poznamka?: string[] }
  /** Vyplněné jen po úspěšné úpravě. Po založení se místo toho přesměrovává. */
  saved?: boolean
}

// ---------------------------------------------------------------------------
// Nový problém
// ---------------------------------------------------------------------------

export async function createProblem(
  _prev: ProblemState,
  formData: FormData,
): Promise<ProblemState> {
  const pristup = await overitPristup()
  if ('chyba' in pristup) return { error: pristup.chyba }
  const { session } = pristup

  const parsed = ProblemSchema.safeParse(precistPoleProblemu(formData))
  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return {
      fieldErrors: {
        nazev: tree.properties?.nazev?.errors,
        icd10: tree.properties?.icd10?.errors,
        poznamka: tree.properties?.poznamka?.errors,
      },
    }
  }

  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const zalozeny = await withPractice(practiceId, async (db) => {
    // Nový problém patří na konec seznamu. Archivované se do výpočtu počítají
    // taky – po obnovení by jinak skočil doprostřed cizího pořadí.
    const posledni = await db.problem.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    })

    const problem = await db.problem.create({
      data: {
        practiceId,
        name: parsed.data.nazev,
        icd10: parsed.data.icd10,
        note: parsed.data.poznamka,
        sortOrder: (posledni?.sortOrder ?? 0) + 1,
      },
      select: { id: true },
    })

    await writeAudit(db, practiceId, {
      action: 'PROBLEM_CREATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { problemId: problem.id, nazev: parsed.data.nazev, icd10: parsed.data.icd10 },
      context,
    })

    return problem
  })

  revalidatePath('/knihovna')

  // Mimo try/catch: redirect() pracuje s výjimkou, kterou musí zpracovat Next.
  redirect(`/knihovna/${zalozeny.id}`)
}

// ---------------------------------------------------------------------------
// Úprava problému
// ---------------------------------------------------------------------------

export async function updateProblem(
  _prev: ProblemState,
  formData: FormData,
): Promise<ProblemState> {
  const pristup = await overitPristup()
  if ('chyba' in pristup) return { error: pristup.chyba }
  const { session } = pristup

  // Identifikátor z formuláře je pro nás jen text, dokud ho nenajdeme v datech
  // vlastní ordinace.
  const problemId = z.uuid().safeParse(formData.get('problemId'))
  if (!problemId.success) return { error: CHYBA_NEZNAMY_PROBLEM }

  const parsed = ProblemSchema.safeParse(precistPoleProblemu(formData))
  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return {
      fieldErrors: {
        nazev: tree.properties?.nazev?.errors,
        icd10: tree.properties?.icd10?.errors,
        poznamka: tree.properties?.poznamka?.errors,
      },
    }
  }

  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const nova = {
    name: parsed.data.nazev,
    icd10: parsed.data.icd10,
    note: parsed.data.poznamka,
  }

  const upraveny = await withPractice(practiceId, async (db) => {
    // Řádek cizí ordinace politika RLS nevrátí, takže null tady znamená
    // „cizí nebo neexistující problém". Bez téhle kontroly by se úprava
    // cizího záznamu tvářila jako úspěch – zápis by prostě nic netrefil.
    const puvodni = await db.problem.findUnique({
      where: { id: problemId.data },
      select: { name: true, icd10: true, note: true },
    })
    if (!puvodni) return null

    await db.problem.update({ where: { id: problemId.data }, data: nova })

    // Do auditu jde jen to, co se opravdu změnilo, a vždy i s původní
    // hodnotou. Záznam „upravil problém" bez obsahu by se později k ničemu
    // nedal použít.
    const zmeny = Object.fromEntries(
      Object.entries(nova)
        .filter(([klic, hodnota]) => hodnota !== puvodni[klic as keyof typeof puvodni])
        .map(([klic, hodnota]) => [klic, { z: puvodni[klic as keyof typeof puvodni], na: hodnota }]),
    )

    await writeAudit(db, practiceId, {
      action: 'PROBLEM_UPDATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { problemId: problemId.data, zmeny },
      context,
    })

    return puvodni
  })

  if (!upraveny) return { error: CHYBA_NEZNAMY_PROBLEM }

  // Název a kód se ukazují i v seznamu, proto se obnovují obě cesty.
  revalidatePath('/knihovna')
  revalidatePath(`/knihovna/${problemId.data}`)

  return { saved: true }
}

// ---------------------------------------------------------------------------
// Archivace a obnovení
// ---------------------------------------------------------------------------

const ArchivaceSchema = z.object({
  problemId: z.uuid({ error: 'Neplatný problém.' }),
  archivovat: z.enum(['ano', 'ne'], { error: 'Neplatný požadavek.' }),
})

export async function setProblemArchived(formData: FormData): Promise<void> {
  const session = await vyzadatSpravceKnihovny()

  const parsed = ArchivaceSchema.safeParse({
    problemId: formData.get('problemId'),
    archivovat: formData.get('archivovat'),
  })
  if (!parsed.success) throw new ForbiddenError('Neplatný požadavek na archivaci problému.')

  const { problemId } = parsed.data
  const archivovat = parsed.data.archivovat === 'ano'
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const cil = await withPractice(practiceId, async (db) => {
    const problem = await db.problem.findUnique({
      where: { id: problemId },
      select: { name: true, archivedAt: true },
    })
    if (!problem) return null

    await db.problem.update({
      where: { id: problemId },
      data: {
        // Dvojí kliknutí na „Archivovat" nemá přepsat datum, kdy se to stalo
        // poprvé.
        archivedAt: archivovat ? (problem.archivedAt ?? new Date()) : null,
      },
    })

    await writeAudit(db, practiceId, {
      action: 'PROBLEM_UPDATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { problemId, nazev: problem.name, archivovano: archivovat },
      context,
    })

    return problem
  })

  if (!cil) throw new ForbiddenError(CHYBA_NEZNAMY_PROBLEM)

  revalidatePath('/knihovna')
  revalidatePath(`/knihovna/${problemId}`)
}
