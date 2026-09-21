import 'server-only'

import type { TenantClient } from './db'

/**
 * Knihovna připravených dokumentů.
 *
 * Hledání je psané syrovým SQL, protože Prisma neumí vyjádřit podobnost slov.
 * Oddělení ordinací to nijak neoslabuje: row-level security platí i pro syrové
 * dotazy uvnitř withPractice() – ověřeno testem v tests/library.test.ts, který
 * schválně nepíše filtr na ordinaci.
 */

export type ProblemHit = {
  id: string
  name: string
  icd10: string | null
  documentCount: number
  /** Přesná shoda kódu MKN-10 – takové výsledky patří nahoru. */
  exactCode: boolean
}

/**
 * Prahová hodnota pro podobnost slov.
 *
 * Operátor % s výchozím prahem 0,3 by „koleno" v „Po operaci kolene" NENAŠEL –
 * podobnost celých řetězců je jen 0,25. Proto se používá word_similarity, která
 * porovnává hledaný výraz s nejlepším úsekem názvu: tam vychází 0,71.
 * Hledaný výraz musí stát VLEVO od operátoru <%.
 */
const WORD_SIMILARITY_THRESHOLD = '0.55'

/** Znaky, kterými by uživatel jinak změnil význam vzoru pro ILIKE. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (znak) => `\\${znak}`)
}

export async function searchProblems(
  db: TenantClient,
  query: string,
  limit = 20,
): Promise<ProblemHit[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return listProblems(db, limit)

  // set_config s posledním argumentem true platí jen do konce transakce,
  // takže se nastavení nepřenese na další požadavek přes sdílené spojení.
  // Čtení téhle hodnoty přes current_setting() by bez načteného modulu
  // spadlo, zápis funguje vždy.
  await db.$executeRaw`
    SELECT set_config('pg_trgm.word_similarity_threshold', ${WORD_SIMILARITY_THRESHOLD}, true)
  `

  const pattern = `%${escapeLike(trimmed)}%`

  return db.$queryRaw<ProblemHit[]>`
    SELECT
      p.id,
      p.name,
      p.icd10,
      (p.icd10 IS NOT NULL AND upper(p.icd10) = upper(${trimmed})) AS "exactCode",
      (
        SELECT count(*)::int
          FROM template_document d
         WHERE d.problem_id = p.id AND d.archived_at IS NULL
      ) AS "documentCount"
    FROM problem p
    WHERE p.archived_at IS NULL
      AND (
        (p.icd10 IS NOT NULL AND upper(p.icd10) = upper(${trimmed}))
        OR ${trimmed} <% p.name
        OR p.name ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY
      "exactCode" DESC,
      word_similarity(${trimmed}, p.name) DESC,
      p.name ASC
    LIMIT ${limit}
  `
}

/** Výchozí seznam, když uživatel ještě nic nenapsal. */
export async function listProblems(db: TenantClient, limit = 50): Promise<ProblemHit[]> {
  return db.$queryRaw<ProblemHit[]>`
    SELECT
      p.id,
      p.name,
      p.icd10,
      false AS "exactCode",
      (
        SELECT count(*)::int
          FROM template_document d
         WHERE d.problem_id = p.id AND d.archived_at IS NULL
      ) AS "documentCount"
    FROM problem p
    WHERE p.archived_at IS NULL
    ORDER BY p.sort_order ASC, p.name ASC
    LIMIT ${limit}
  `
}

export type LibraryDocument = {
  id: string
  title: string
  sortOrder: number
  archivedAt: Date | null
  currentVersionId: string | null
  version: number | null
  pageCount: number | null
  sizeBytes: number | null
  updatedAt: Date
  versionCount: number
}

export type ProblemDetail = {
  id: string
  name: string
  icd10: string | null
  note: string | null
  archivedAt: Date | null
  documents: LibraryDocument[]
}

/**
 * Detail problému i s dokumenty.
 *
 * Vrací se i archivované dokumenty – v knihovně se dají zobrazit, jen se
 * nenabízejí při přípravě balíčku.
 */
export async function getProblemDetail(
  db: TenantClient,
  problemId: string,
): Promise<ProblemDetail | null> {
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    select: {
      id: true,
      name: true,
      icd10: true,
      note: true,
      archivedAt: true,
      documents: {
        orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          title: true,
          sortOrder: true,
          archivedAt: true,
          currentVersionId: true,
          updatedAt: true,
          currentVersion: { select: { version: true, pageCount: true, sizeBytes: true } },
          _count: { select: { versions: true } },
        },
      },
    },
  })

  if (!problem) return null

  return {
    id: problem.id,
    name: problem.name,
    icd10: problem.icd10,
    note: problem.note,
    archivedAt: problem.archivedAt,
    documents: problem.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      sortOrder: doc.sortOrder,
      archivedAt: doc.archivedAt,
      currentVersionId: doc.currentVersionId,
      version: doc.currentVersion?.version ?? null,
      pageCount: doc.currentVersion?.pageCount ?? null,
      sizeBytes: doc.currentVersion?.sizeBytes ?? null,
      updatedAt: doc.updatedAt,
      versionCount: doc._count.versions,
    })),
  }
}

/** Dokumenty, které se předvyberou při přípravě balíčku pro daný problém. */
export async function getPreselectedDocuments(
  db: TenantClient,
  problemId: string,
): Promise<{ documentId: string; versionId: string; title: string; pageCount: number }[]> {
  const documents = await db.templateDocument.findMany({
    where: { problemId, archivedAt: null, currentVersionId: { not: null } },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      title: true,
      currentVersionId: true,
      currentVersion: { select: { pageCount: true } },
    },
  })

  return documents.map((doc) => ({
    documentId: doc.id,
    versionId: doc.currentVersionId!,
    title: doc.title,
    pageCount: doc.currentVersion?.pageCount ?? 0,
  }))
}
