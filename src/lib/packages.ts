import 'server-only'

import { randomUUID } from 'node:crypto'

import { writeAudit } from './audit'
import { decryptFile, decryptOptional, encryptFile, encryptOptional, sha256Hex } from './crypto'
import { withPractice, type TenantClient } from './db'
import { imageToPdf, inspectPdf, looksLikePdf, mergePdfs, PdfError } from './pdf'
import type { RequestInfo } from './request-context'
import { storage, storageKeys, StorageNotFoundError } from './storage'

/**
 * Balíček dokumentů pro pacienta.
 *
 * Vzniká jako rozpracovaný (DRAFT) hned, jak lékař začne – ještě než se
 * rozhodne, jestli ho předá přes čip, vytiskne, nebo pošle e-mailem. Díky tomu
 * má nahraná lékařská zpráva kam patřit a v auditu je vidět celá cesta, ne až
 * její konec. Rozpracované balíčky, ze kterých nic nebylo, uklidí denní úloha.
 */

export class PackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageError'
  }
}

export type PackageDocumentInput =
  /** Dokument z knihovny – ukládá se konkrétní VERZE, ne dokument. */
  | { kind: 'TEMPLATE'; templateVersionId: string }
  /** Lékařská zpráva nebo sken nahraný k tomuhle balíčku. */
  | { kind: 'UPLOAD'; uploadedFileId: string }

export type PackageDocumentView = {
  id: string
  kind: 'TEMPLATE' | 'UPLOAD'
  title: string
  pageCount: number
  sortOrder: number
}

export type PackageView = {
  id: string
  status: 'DRAFT' | 'READY' | 'HANDED' | 'EXPIRED' | 'REVOKED'
  problemId: string | null
  problemName: string | null
  patientLabel: string | null
  note: string | null
  documents: PackageDocumentView[]
  totalPages: number
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Založení a úpravy
// ---------------------------------------------------------------------------

export async function createDraftPackage(params: {
  practiceId: string
  userId: string
  userName: string
  problemId?: string
  context: RequestInfo
}): Promise<string> {
  return withPractice(params.practiceId, async (db) => {
    const created = await db.package.create({
      data: {
        practiceId: params.practiceId,
        createdById: params.userId,
        problemId: params.problemId ?? null,
        status: 'DRAFT',
      },
      select: { id: true },
    })

    await writeAudit(db, params.practiceId, {
      action: 'PACKAGE_CREATED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      packageId: created.id,
      metadata: { problemId: params.problemId ?? null },
      context: params.context,
    })

    return created.id
  })
}

/**
 * Přepíše seznam dokumentů v balíčku.
 *
 * Pořadí v poli je pořadím, ve kterém pacient dokumenty uvidí i ve kterém se
 * sloučí k tisku. Názvy se zmrazí – po pozdějším přejmenování v knihovně
 * uvidí pacient pořád to, co dostal.
 */
export async function setPackageDocuments(params: {
  practiceId: string
  userId: string
  userName: string
  packageId: string
  items: PackageDocumentInput[]
  patientLabel?: string | null
  note?: string | null
  /**
   * Problém se dá změnit i dodatečně. Lékař někdy přetáhne zprávu dřív, než
   * najde diagnózu – balíček tou dobou už existuje a bez tohohle by v historii
   * navždy zůstal bez problému.
   */
  problemId?: string | null
  context: RequestInfo
}): Promise<PackageView> {
  return withPractice(params.practiceId, async (db) => {
    const balicek = await db.package.findUnique({
      where: { id: params.packageId },
      select: { id: true, status: true },
    })
    // Row-level security cizí balíček nevrátí, takže null znamená „není tvůj
    // nebo neexistuje". Ven jde jedna hláška pro obojí.
    if (!balicek) throw new PackageError('Balíček se nepodařilo najít.')
    if (balicek.status !== 'DRAFT' && balicek.status !== 'READY') {
      throw new PackageError('Balíček už byl předaný a nedá se měnit. Připravte prosím nový.')
    }

    const nazvy = await resolveTitles(db, params.items)

    await db.packageDocument.deleteMany({ where: { packageId: params.packageId } })

    if (params.items.length > 0) {
      await db.packageDocument.createMany({
        data: params.items.map((item, index) => ({
          practiceId: params.practiceId,
          packageId: params.packageId,
          kind: item.kind,
          templateVersionId: item.kind === 'TEMPLATE' ? item.templateVersionId : null,
          uploadedFileId: item.kind === 'UPLOAD' ? item.uploadedFileId : null,
          title: nazvy.get(klic(item)) ?? 'Dokument',
          sortOrder: index,
        })),
      })
    }

    if (params.problemId !== undefined && params.problemId !== null) {
      // Že problém patří téhle ordinaci, ověří row-level security: co nevrátí,
      // to se nepřiřadí. Identifikátor přichází z prohlížeče.
      const problem = await db.problem.findUnique({
        where: { id: params.problemId },
        select: { id: true },
      })
      if (!problem) {
        throw new PackageError('Vybraný problém už neexistuje. Načtěte prosím stránku znovu.')
      }
    }

    await db.package.update({
      where: { id: params.packageId },
      data: {
        status: params.items.length > 0 ? 'READY' : 'DRAFT',
        ...(params.problemId !== undefined ? { problemId: params.problemId } : {}),
        ...(params.patientLabel !== undefined
          ? { patientLabelEnc: encryptOptional(params.patientLabel) }
          : {}),
        ...(params.note !== undefined ? { noteEnc: encryptOptional(params.note) } : {}),
      },
    })

    await writeAudit(db, params.practiceId, {
      action: 'PACKAGE_UPDATED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      packageId: params.packageId,
      metadata: { pocetDokumentu: params.items.length },
      context: params.context,
    })

    const view = await loadPackage(db, params.packageId)
    if (!view) throw new PackageError('Balíček se nepodařilo načíst.')
    return view
  })
}

function klic(item: PackageDocumentInput): string {
  return item.kind === 'TEMPLATE' ? `T:${item.templateVersionId}` : `U:${item.uploadedFileId}`
}

/**
 * Dohledá názvy vkládaných dokumentů.
 *
 * Zároveň je to kontrola, že všechny opravdu patří téhle ordinaci: co
 * row-level security nevrátí, nemá název a vložení se odmítne. Identifikátory
 * přicházejí z prohlížeče, takže se jim nevěří.
 */
async function resolveTitles(
  db: TenantClient,
  items: PackageDocumentInput[],
): Promise<Map<string, string>> {
  const templateIds = items.filter((i) => i.kind === 'TEMPLATE').map((i) => i.templateVersionId)
  const uploadIds = items.filter((i) => i.kind === 'UPLOAD').map((i) => i.uploadedFileId)

  const nazvy = new Map<string, string>()

  if (templateIds.length > 0) {
    const verze = await db.templateDocumentVersion.findMany({
      where: { id: { in: templateIds } },
      select: { id: true, document: { select: { title: true } } },
    })
    for (const v of verze) nazvy.set(`T:${v.id}`, v.document.title)
  }

  if (uploadIds.length > 0) {
    const soubory = await db.uploadedFile.findMany({
      where: { id: { in: uploadIds } },
      select: { id: true },
    })
    for (const s of soubory) nazvy.set(`U:${s.id}`, 'Lékařská zpráva')
  }

  const chybejici = items.filter((item) => !nazvy.has(klic(item)))
  if (chybejici.length > 0) {
    throw new PackageError('Některý z vybraných dokumentů už neexistuje. Načtěte prosím stránku znovu.')
  }

  return nazvy
}

// ---------------------------------------------------------------------------
// Lékařská zpráva
// ---------------------------------------------------------------------------

/**
 * Přijme lékařskou zprávu nebo sken k balíčku.
 *
 * Stejné pořadí kroků jako u knihovny: nejdřív ověřit obsah, pak zapsat do
 * úložiště mimo transakci, a když selže databáze, obsah z úložiště uklidit.
 */
export async function uploadPackageReport(params: {
  practiceId: string
  userId: string
  userName: string
  packageId: string
  bytes: Buffer
  mimeType: string
  context: RequestInfo
}): Promise<{ uploadedFileId: string; pageCount: number }> {
  const pdfBytes = await toPdf(params.bytes, params.mimeType)
  const { pageCount } = await inspectPdf(pdfBytes)

  const uploadId = randomUUID()
  const storageKey = storageKeys.upload(params.practiceId, uploadId)
  const encrypted = encryptFile(pdfBytes, storageKey)

  await (await storage()).put(storageKey, encrypted.ciphertext)

  try {
    return await withPractice(params.practiceId, async (db) => {
      const balicek = await db.package.findUnique({
        where: { id: params.packageId },
        select: { status: true },
      })
      if (!balicek) throw new PackageError('Balíček se nepodařilo najít.')
      if (balicek.status !== 'DRAFT' && balicek.status !== 'READY') {
        throw new PackageError('Balíček už byl předaný a nedá se měnit.')
      }

      await db.uploadedFile.create({
        data: {
          id: uploadId,
          practiceId: params.practiceId,
          packageId: params.packageId,
          storageKey,
          sizeBytes: pdfBytes.byteLength,
          pageCount,
          sha256: sha256Hex(pdfBytes),
          mimeType: 'application/pdf',
          dekWrapped: encrypted.dekWrapped,
          contentIv: encrypted.contentIv,
          contentTag: encrypted.contentTag,
          keyVersion: encrypted.keyVersion,
          uploadedById: params.userId,
        },
      })

      await writeAudit(db, params.practiceId, {
        action: 'PACKAGE_UPDATED',
        actorType: 'USER',
        actorUserId: params.userId,
        actorName: params.userName,
        packageId: params.packageId,
        metadata: { akce: 'nahrani_zpravy', pageCount },
        context: params.context,
      })

      return { uploadedFileId: uploadId, pageCount }
    })
  } catch (error) {
    await (await storage())
      .delete(storageKey)
      .catch((cleanupError) =>
        console.error(`[medpredani] osiřelý obsah v úložišti: ${storageKey}`, cleanupError),
      )
    throw error
  }
}

async function toPdf(bytes: Buffer, mimeType: string): Promise<Buffer> {
  if (looksLikePdf(bytes)) return bytes
  if (mimeType.startsWith('image/')) return imageToPdf(bytes, mimeType)
  throw new PdfError('neni-pdf')
}

// ---------------------------------------------------------------------------
// Čtení a sestavení
// ---------------------------------------------------------------------------

export async function loadPackage(
  db: TenantClient,
  packageId: string,
): Promise<PackageView | null> {
  const balicek = await db.package.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      status: true,
      problemId: true,
      patientLabelEnc: true,
      noteEnc: true,
      createdAt: true,
      problem: { select: { name: true } },
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

  if (!balicek) return null

  const documents = balicek.documents.map((doc) => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    pageCount: doc.templateVersion?.pageCount ?? doc.uploadedFile?.pageCount ?? 0,
    sortOrder: doc.sortOrder,
  }))

  return {
    id: balicek.id,
    status: balicek.status,
    problemId: balicek.problemId,
    problemName: balicek.problem?.name ?? null,
    patientLabel: decryptOptional(balicek.patientLabelEnc),
    note: decryptOptional(balicek.noteEnc),
    documents,
    totalPages: documents.reduce((soucet, doc) => soucet + doc.pageCount, 0),
    createdAt: balicek.createdAt,
  }
}

/**
 * Načte obsah všech dokumentů balíčku v pořadí, v jakém jsou.
 *
 * Používá se pro tisk i pro pacientské „stáhnout vše jako jedno PDF".
 * Chybějící obsah v úložišti je tvrdá chyba – tiše vynechat stránku
 * z lékařské dokumentace by bylo horší než nevytisknout nic.
 */
export async function loadPackageContents(
  db: TenantClient,
  packageId: string,
): Promise<{ title: string; bytes: Buffer }[]> {
  const documents = await db.packageDocument.findMany({
    where: { packageId },
    orderBy: { sortOrder: 'asc' },
    select: {
      title: true,
      templateVersion: {
        select: { storageKey: true, dekWrapped: true, contentIv: true, contentTag: true },
      },
      uploadedFile: {
        select: { storageKey: true, dekWrapped: true, contentIv: true, contentTag: true, deletedAt: true },
      },
    },
  })

  const ulozene = await storage()
  const vysledek: { title: string; bytes: Buffer }[] = []

  for (const doc of documents) {
    const zdroj = doc.templateVersion ?? doc.uploadedFile
    if (!zdroj) throw new PackageError('Dokument v balíčku chybí.')
    if (doc.uploadedFile?.deletedAt) {
      throw new PackageError('Obsah balíčku byl po vypršení platnosti smazán.')
    }

    try {
      const ciphertext = await ulozene.get(zdroj.storageKey)
      vysledek.push({
        title: doc.title,
        bytes: decryptFile({
          ciphertext,
          dekWrapped: zdroj.dekWrapped,
          contentIv: zdroj.contentIv,
          contentTag: zdroj.contentTag,
          storageKey: zdroj.storageKey,
        }),
      })
    } catch (error) {
      if (error instanceof StorageNotFoundError) {
        throw new PackageError('Obsah jednoho z dokumentů se nepodařilo načíst.')
      }
      throw error
    }
  }

  return vysledek
}

/** Sloučí celý balíček do jednoho PDF. */
export async function buildPackagePdf(db: TenantClient, packageId: string): Promise<Buffer> {
  const parts = await loadPackageContents(db, packageId)
  if (parts.length === 0) {
    throw new PackageError('Balíček neobsahuje žádný dokument.')
  }
  return mergePdfs(parts.map((part) => part.bytes))
}
