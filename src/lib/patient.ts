import 'server-only'

import { writeAudit } from './audit'
import { hashToken, secretMatches } from './crypto'
import { resolverClient, withPractice, type TenantClient } from './db'
import { loadPackageContents, type PackageDocumentView } from './packages'
import { mergePdfs } from './pdf'
import type { RequestInfo } from './request-context'

/**
 * Přístup pacienta k balíčku přes adresu /d/<token>.
 *
 * Pacient nemá účet. Jediné, co ho opravňuje, je token s 256 bity entropie,
 * kterého se v databázi drží jen SHA-256 – únik databáze tedy odkazy
 * neprozradí. Krátký hash tu stačí právě proto, že token není heslo: nedá se
 * uhodnout ani odvodit.
 */

export class PatientAccessError extends Error {
  constructor(
    readonly reason: 'neplatny' | 'vyprsel' | 'zneplatnen' | 'smazano' | 'overeni',
    message: string,
  ) {
    super(message)
    this.name = 'PatientAccessError'
  }
}

export type PatientPackage = {
  tokenId: string
  practiceId: string
  practiceName: string
  packageId: string
  expiresAt: Date
  documents: PackageDocumentView[]
  totalPages: number
  /** Ověření ještě neproběhlo – pacient musí zadat PIN nebo datum narození. */
  needsVerification: 'PIN' | 'DOB' | null
}

/**
 * Přeloží token z adresy na ordinaci.
 *
 * Běží pod rozlišovací rolí – v tuhle chvíli ordinaci ještě neznáme. Ta role
 * má na tabulku tokenů sloupcový grant, takže se k hashi ověřovacího PINu
 * vůbec nedostane; ten se ověřuje až pod aplikační rolí.
 */
async function resolveToken(token: string): Promise<{
  id: string
  practiceId: string
  packageId: string
  expiresAt: Date
  revokedAt: Date | null
  verificationType: 'NONE' | 'PIN' | 'DOB'
} | null> {
  if (token.length < 20 || token.length > 100) return null

  const row = await resolverClient.patientAccessToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      practiceId: true,
      packageId: true,
      expiresAt: true,
      revokedAt: true,
      verificationType: true,
    },
  })

  return row
}

/**
 * Načte balíček pro pacienta.
 *
 * Všechny důvody odmítnutí – neplatný token, vypršelý, zneplatněný – vypadají
 * ven stejně. Kdo token nemá, se nesmí dozvědět ani to, jestli někdy existoval.
 */
export async function openPatientPackage(
  token: string,
  context: RequestInfo,
): Promise<PatientPackage> {
  const row = await resolveToken(token)
  if (!row) {
    throw new PatientAccessError('neplatny', 'Tenhle odkaz neplatí.')
  }
  if (row.revokedAt) {
    throw new PatientAccessError('zneplatnen', 'Platnost odkazu skončila.')
  }
  if (row.expiresAt <= new Date()) {
    throw new PatientAccessError('vyprsel', 'Platnost odkazu skončila.')
  }

  return withPractice(row.practiceId, async (db) => {
    const balicek = await db.package.findUnique({
      where: { id: row.packageId },
      select: {
        id: true,
        purgedAt: true,
        practice: { select: { name: true } },
        documents: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            kind: true,
            title: true,
            sortOrder: true,
            templateVersion: { select: { pageCount: true } },
            uploadedFile: { select: { pageCount: true } },
          },
        },
      },
    })

    if (!balicek || balicek.purgedAt) {
      throw new PatientAccessError('smazano', 'Platnost odkazu skončila a dokumenty byly smazány.')
    }

    const verified = await db.patientAccessToken.findUnique({
      where: { id: row.id },
      select: { verifiedAt: true },
    })

    const documents = balicek.documents.map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      pageCount: doc.templateVersion?.pageCount ?? doc.uploadedFile?.pageCount ?? 0,
      sortOrder: doc.sortOrder,
    }))

    return {
      tokenId: row.id,
      practiceId: row.practiceId,
      practiceName: balicek.practice.name,
      packageId: balicek.id,
      expiresAt: row.expiresAt,
      documents,
      totalPages: documents.reduce((soucet, d) => soucet + d.pageCount, 0),
      needsVerification:
        row.verificationType === 'NONE' || verified?.verifiedAt
          ? null
          : (row.verificationType as 'PIN' | 'DOB'),
    }
  })
}

/** Zaznamená, že pacient stránku otevřel. Volá se po úspěšném načtení. */
export async function recordPatientVisit(
  practiceId: string,
  tokenId: string,
  packageId: string,
  context: RequestInfo,
): Promise<void> {
  await withPractice(practiceId, async (db) => {
    const now = new Date()
    // Jediným příkazem: první návštěva se zapíše jen tehdy, když ještě žádná
    // nebyla. Přes Prisma to vyjádřit nejde – uměla by jen bezpodmínečný zápis.
    await db.$executeRaw`
      UPDATE patient_access_token
         SET first_accessed_at = COALESCE(first_accessed_at, ${now}),
             last_accessed_at  = ${now},
             access_count      = access_count + 1
       WHERE id = ${tokenId}::uuid
    `

    await writeAudit(db, practiceId, {
      action: 'PATIENT_PAGE_VIEWED',
      actorType: 'PATIENT',
      packageId,
      tokenId,
      context,
    })
  })
}

/**
 * Ověří PIN nebo datum narození u odkazu poslaného e-mailem.
 *
 * Stejně jako u kódu předání je počítadlo pokusů na tokenu, ne na IP adrese.
 * Neúspěch se z transakce VRACÍ, nevyhazuje – jinak by se zvýšené počítadlo
 * vrátilo zpět spolu s výjimkou a zámek by nikdy nenastal.
 */
const MAX_VERIFY_ATTEMPTS = 6

export async function verifyPatientAccess(params: {
  token: string
  answer: string
  context: RequestInfo
}): Promise<void> {
  const row = await resolveToken(params.token)
  if (!row) throw new PatientAccessError('neplatny', 'Tenhle odkaz neplatí.')

  // Zneplatněný nebo vypršelý odkaz se nesmí dát ani ověřovat. Přístup by sice
  // stejně nedal (openPatientPackage to kontroluje), ale bez tohohle by šlo na
  // mrtvém odkazu donekonečna zkoušet PIN a v auditu by přibývaly pokusy
  // o ověření něčeho, co už neexistuje.
  if (row.revokedAt || row.expiresAt <= new Date()) {
    throw new PatientAccessError('vyprsel', 'Platnost odkazu skončila.')
  }

  const vysledek = await withPractice(
    row.practiceId,
    async (db): Promise<{ ok: boolean; message: string }> => {
      const zamcene = await db.$queryRaw<
        { id: string; verification_hmac: string | null; verify_attempts: number }[]
      >`
        SELECT id, verification_hmac, verify_attempts
          FROM patient_access_token
         WHERE id = ${row.id}::uuid
         FOR UPDATE
      `

      const t = zamcene[0]
      if (!t?.verification_hmac) {
        return { ok: false, message: 'Tenhle odkaz neplatí.' }
      }
      if (t.verify_attempts >= MAX_VERIFY_ATTEMPTS) {
        return {
          ok: false,
          message: 'Příliš mnoho pokusů. Požádejte prosím ordinaci o nový odkaz.',
        }
      }

      if (!secretMatches(params.answer.trim(), t.verification_hmac)) {
        await db.patientAccessToken.update({
          where: { id: row.id },
          data: { verifyAttempts: { increment: 1 } },
        })
        await writeAudit(db, row.practiceId, {
          action: 'PATIENT_VERIFY_FAILED',
          actorType: 'PATIENT',
          packageId: row.packageId,
          tokenId: row.id,
          metadata: { pokus: t.verify_attempts + 1 },
          context: params.context,
        })
        return { ok: false, message: 'Údaj nesouhlasí. Zkuste to prosím znovu.' }
      }

      await db.patientAccessToken.update({
        where: { id: row.id },
        data: { verifiedAt: new Date(), verifyAttempts: 0 },
      })

      return { ok: true, message: '' }
    },
  )

  if (!vysledek.ok) throw new PatientAccessError('overeni', vysledek.message)
}

/** Obsah jednoho dokumentu z balíčku pacienta. */
export async function readPatientDocument(
  db: TenantClient,
  packageId: string,
  packageDocumentId: string,
): Promise<{ title: string; bytes: Buffer } | null> {
  const doc = await db.packageDocument.findUnique({
    where: { id: packageDocumentId },
    select: { packageId: true },
  })
  // Dokument z jiného balíčku se nesmí dát stáhnout ani se správným tokenem.
  if (!doc || doc.packageId !== packageId) return null

  const obsah = await loadPackageContents(db, packageId)
  const vsechny = await db.packageDocument.findMany({
    where: { packageId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  })

  const index = vsechny.findIndex((d) => d.id === packageDocumentId)
  return index >= 0 ? (obsah[index] ?? null) : null
}

/** Celý balíček jako jedno PDF. */
export async function buildPatientPdf(db: TenantClient, packageId: string): Promise<Buffer> {
  const parts = await loadPackageContents(db, packageId)
  return mergePdfs(parts.map((p) => p.bytes))
}
