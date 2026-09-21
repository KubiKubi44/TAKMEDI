import 'server-only'

import { randomUUID } from 'node:crypto'

import { Prisma } from '@/generated/prisma/client'
import { writeAudit } from './audit'
import { decryptFile, encryptFile, sha256Hex } from './crypto'
import { withPractice, type TenantClient } from './db'
import { PdfError, imageToPdf, inspectPdf, looksLikePdf } from './pdf'
import type { RequestInfo } from './request-context'
import { storage, storageKeys, StorageNotFoundError } from './storage'

/**
 * Dokumenty v knihovně a jejich verze.
 *
 * Balíček pacienta si drží odkaz na konkrétní VERZI, ne na dokument. Když
 * ordinace leták později přepíše, historie zůstane pravdivá a pacient uvidí
 * přesně to, co dostal.
 */

export class LibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LibraryError'
  }
}

type UploadInput = {
  practiceId: string
  userId: string
  userName: string
  /** Nový dokument v tomhle problému. */
  problemId?: string
  /** Nebo nová verze už existujícího dokumentu. */
  documentId?: string
  title: string
  bytes: Buffer
  mimeType: string
  context: RequestInfo
}

export type UploadResult = {
  documentId: string
  versionId: string
  version: number
  pageCount: number
}

/**
 * Přijme soubor do knihovny.
 *
 * Pořadí kroků není náhodné:
 *  1. obsah se ověří DŘÍV, než se cokoli uloží – lékař u obrazovky může soubor
 *     hned vyměnit,
 *  2. do úložiště se zapíše mimo databázovou transakci, aby transakce nedržela
 *     spojení po dobu síťové operace,
 *  3. když pak selže zápis do databáze, obsah z úložiště se uklidí.
 *
 * Zbývá úzké okno, ve kterém selže i ten úklid a v úložišti zůstane osiřelý
 * blok. Nic neprozradí (je zašifrovaný a nic na něj neodkazuje) a zabere jen
 * místo, takže se to řeší logem, ne složitější strojovnou.
 */
export async function uploadTemplateVersion(input: UploadInput): Promise<UploadResult> {
  if (!input.problemId && !input.documentId) {
    throw new LibraryError('Není řečeno, kam dokument patří.')
  }

  const pdfBytes = await toPdf(input.bytes, input.mimeType)
  const { pageCount } = await inspectPdf(pdfBytes)

  const versionId = randomUUID()
  const storageKey = storageKeys.templateVersion(input.practiceId, versionId)
  const encrypted = encryptFile(pdfBytes, storageKey)

  await (await storage()).put(storageKey, encrypted.ciphertext)

  try {
    return await withPractice(input.practiceId, async (db) => {
      const documentId = input.documentId ?? (await createDocument(db, input))
      const version = await nextVersionNumber(db, documentId)

      const created = await db.templateDocumentVersion.create({
        data: {
          id: versionId,
          practiceId: input.practiceId,
          templateDocumentId: documentId,
          version,
          storageKey,
          sizeBytes: pdfBytes.byteLength,
          pageCount,
          sha256: sha256Hex(pdfBytes),
          dekWrapped: encrypted.dekWrapped,
          contentIv: encrypted.contentIv,
          contentTag: encrypted.contentTag,
          keyVersion: encrypted.keyVersion,
          uploadedById: input.userId,
        },
      })

      await db.templateDocument.update({
        where: { id: documentId },
        data: {
          currentVersionId: created.id,
          // Nahrání nové verze archivovaný dokument zase oživí – je to
          // srozumitelnější než tiché nahrání do něčeho, co nikdo neuvidí.
          archivedAt: null,
          ...(input.documentId ? {} : { title: input.title }),
        },
      })

      await writeAudit(db, input.practiceId, {
        action: 'TEMPLATE_UPLOADED',
        actorType: 'USER',
        actorUserId: input.userId,
        actorName: input.userName,
        documentId,
        metadata: { versionId, version, pageCount, sizeBytes: pdfBytes.byteLength },
        context: input.context,
      })

      return { documentId, versionId, version, pageCount }
    })
  } catch (error) {
    // Do úložiště už se zapsalo, ale databáze zápis nepřijala. Uklidit.
    await (await storage())
      .delete(storageKey)
      .catch((cleanupError) => {
        console.error(
          `[medpredani] osiřelý obsah v úložišti: ${storageKey} – smazat ručně`,
          cleanupError,
        )
      })

    if (isVersionCollision(error)) {
      // Dva lidé nahráli novou verzi téhož dokumentu naráz. Jeden vyhrál,
      // druhý dostane srozumitelnou hlášku místo technické chyby.
      throw new LibraryError('Někdo právě nahrál novější verzi. Zkuste to prosím znovu.')
    }
    throw error
  }
}

/**
 * Pozná právě to porušení unikátního omezení, které znamená souběh verzí.
 *
 * Nestačí kontrolovat kód P2002: porušit se dá i jiné omezení a uživatel by
 * pak dostal hlášku o novější verzi u něčeho úplně jiného. Název indexu je
 * v téhle verzi Prismy zanořený v chybě ovladače, ne v obvyklém meta.target.
 */
function isVersionCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }

  const meta = error.meta as
    | { target?: string[] | string; driverAdapterError?: { cause?: { constraint?: { index?: string; fields?: string[] } } } }
    | undefined

  const index = meta?.driverAdapterError?.cause?.constraint?.index
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields
  const target = Array.isArray(meta?.target) ? meta.target.join(',') : (meta?.target ?? '')

  const haystack = [index ?? '', (fields ?? []).join(','), target, error.message].join(' ')
  return haystack.includes('template_document_id') || haystack.includes('version')
}

/** Fotka nebo sken se převede na PDF, PDF se nechá být. */
async function toPdf(bytes: Buffer, mimeType: string): Promise<Buffer> {
  if (looksLikePdf(bytes)) return bytes
  if (mimeType.startsWith('image/')) return imageToPdf(bytes, mimeType)

  // Deklarovanému typu se nevěří – rozhoduje obsah.
  throw new PdfError('neni-pdf')
}

async function createDocument(db: TenantClient, input: UploadInput): Promise<string> {
  const last = await db.templateDocument.findFirst({
    where: { problemId: input.problemId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })

  const created = await db.templateDocument.create({
    data: {
      practiceId: input.practiceId,
      problemId: input.problemId!,
      title: input.title,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
  })

  return created.id
}

/**
 * Další číslo verze.
 *
 * Souběh hlídá unikátní omezení na (templateDocumentId, version) v databázi,
 * ne tenhle výpočet – dva souběžné zápisy tu jinak dojdou ke stejnému číslu.
 */
async function nextVersionNumber(db: TenantClient, documentId: string): Promise<number> {
  const last = await db.templateDocumentVersion.findFirst({
    where: { templateDocumentId: documentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  return (last?.version ?? 0) + 1
}

/**
 * Načte a dešifruje obsah verze.
 *
 * Volá se až po ověření oprávnění. Klíč z databáze a cesta v úložišti musí
 * sedět k sobě – cesta vstupuje do šifrování jako doplňková autentizovaná data,
 * takže prohozený blok dešifrování neprojde.
 */
export async function readTemplateVersion(
  db: TenantClient,
  versionId: string,
): Promise<{ bytes: Buffer; title: string; pageCount: number } | null> {
  const version = await db.templateDocumentVersion.findUnique({
    where: { id: versionId },
    select: {
      storageKey: true,
      dekWrapped: true,
      contentIv: true,
      contentTag: true,
      pageCount: true,
      document: { select: { title: true } },
    },
  })

  if (!version) return null

  try {
    const ciphertext = await (await storage()).get(version.storageKey)
    return {
      bytes: decryptFile({
        ciphertext,
        dekWrapped: version.dekWrapped,
        contentIv: version.contentIv,
        contentTag: version.contentTag,
        storageKey: version.storageKey,
      }),
      title: version.document.title,
      pageCount: version.pageCount,
    }
  } catch (error) {
    if (error instanceof StorageNotFoundError) return null
    throw error
  }
}
