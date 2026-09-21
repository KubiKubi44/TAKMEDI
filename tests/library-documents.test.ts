import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, withPractice } from '@/lib/db'
import { LibraryError, readTemplateVersion, uploadTemplateVersion } from '@/lib/library-documents'
import { PdfError } from '@/lib/pdf'
import { storage, storageKeys } from '@/lib/storage'
import { createPractice, ownerClient, removePractice } from './helpers'
import { TINY_JPEG, makePdf } from './fixtures/pdf'

let a: Awaited<ReturnType<typeof createPractice>>
let b: Awaited<ReturnType<typeof createPractice>>
let problemA: string
let problemB: string

const context = { ip: null, userAgent: null }

function vstup(overrides: Record<string, unknown> = {}) {
  return {
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    problemId: problemA,
    title: 'Poučení po operaci',
    mimeType: 'application/pdf',
    context,
    ...overrides,
  } as Parameters<typeof uploadTemplateVersion>[0]
}

beforeAll(async () => {
  a = await createPractice('Dokumenty A')
  b = await createPractice('Dokumenty B')

  problemA = (
    await ownerClient.problem.create({
      data: { practiceId: a.practice.id, name: 'Po operaci kolene', icd10: 'Z96.6' },
    })
  ).id
  problemB = (
    await ownerClient.problem.create({
      data: { practiceId: b.practice.id, name: 'Cizí problém' },
    })
  ).id
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('nahrání dokumentu', () => {
  it('založí dokument, první verzi a spočítá strany', async () => {
    const result = await uploadTemplateVersion(vstup({ bytes: await makePdf('Pouceni', 3) }))

    expect(result.version).toBe(1)
    expect(result.pageCount).toBe(3)

    const doc = await ownerClient.templateDocument.findUniqueOrThrow({
      where: { id: result.documentId },
    })
    expect(doc.title).toBe('Poučení po operaci')
    expect(doc.currentVersionId).toBe(result.versionId)
  })

  it('v úložišti neleží čitelný obsah', async () => {
    const result = await uploadTemplateVersion(vstup({ bytes: await makePdf('Tajne', 1) }))

    const raw = await (await storage()).get(storageKeys.templateVersion(a.practice.id, result.versionId))
    expect(raw.subarray(0, 5).toString('latin1')).not.toBe('%PDF-')
  })

  it('přečtení verze vrátí původní obsah', async () => {
    const puvodni = await makePdf('Rezim', 2)
    const result = await uploadTemplateVersion(vstup({ bytes: puvodni }))

    const nactene = await withPractice(a.practice.id, (db) =>
      readTemplateVersion(db, result.versionId),
    )

    expect(nactene?.bytes.equals(puvodni)).toBe(true)
    expect(nactene?.pageCount).toBe(2)
  })

  it('fotka se převede na jednostránkové PDF', async () => {
    const result = await uploadTemplateVersion(
      vstup({ bytes: TINY_JPEG, mimeType: 'image/jpeg', title: 'Sken' }),
    )
    expect(result.pageCount).toBe(1)

    const nactene = await withPractice(a.practice.id, (db) =>
      readTemplateVersion(db, result.versionId),
    )
    expect(nactene?.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('verzování', () => {
  it('další nahrání do téhož dokumentu zvýší verzi a přepne aktuální', async () => {
    const prvni = await uploadTemplateVersion(vstup({ bytes: await makePdf('v1', 1) }))
    const druha = await uploadTemplateVersion(
      vstup({ documentId: prvni.documentId, problemId: undefined, bytes: await makePdf('v2', 5) }),
    )

    expect(druha.version).toBe(2)
    expect(druha.documentId).toBe(prvni.documentId)

    const doc = await ownerClient.templateDocument.findUniqueOrThrow({
      where: { id: prvni.documentId },
    })
    expect(doc.currentVersionId).toBe(druha.versionId)
  })

  it('stará verze zůstane čitelná i po nahrání nové', async () => {
    // Na tom stojí pravdivost historie: balíček odkazuje na konkrétní verzi.
    const puvodni = await makePdf('Stara verze', 1)
    const prvni = await uploadTemplateVersion(vstup({ bytes: puvodni }))
    await uploadTemplateVersion(
      vstup({ documentId: prvni.documentId, problemId: undefined, bytes: await makePdf('Nova', 9) }),
    )

    const stara = await withPractice(a.practice.id, (db) =>
      readTemplateVersion(db, prvni.versionId),
    )
    expect(stara?.bytes.equals(puvodni)).toBe(true)
    expect(stara?.pageCount).toBe(1)
  })
})

describe('souběh při verzování', () => {
  it('dvě nahrání téhož dokumentu nikdy nedostanou stejné číslo verze', async () => {
    // Číslo verze se počítá jako nejvyšší + 1, takže při skutečném souběhu
    // dojdou oba ke stejnému. Hlídá to unikátní omezení v databázi, ne ten
    // výpočet. Test nezkoumá, KDO vyhraje – to záleží na načasování – ale to,
    // co platit musí vždy: čísla verzí jsou různá a žádné nahrání se neztratí.
    const zaklad = await uploadTemplateVersion(vstup({ bytes: await makePdf('Zaklad', 1) }))

    const vysledky = await Promise.allSettled([
      uploadTemplateVersion(
        vstup({ documentId: zaklad.documentId, problemId: undefined, bytes: await makePdf('A', 2) }),
      ),
      uploadTemplateVersion(
        vstup({ documentId: zaklad.documentId, problemId: undefined, bytes: await makePdf('B', 3) }),
      ),
    ])

    for (const v of vysledky) {
      if (v.status === 'rejected') {
        // Poražený nesmí dostat technickou chybu Prismy, ale větu, ze které
        // pozná, co má udělat.
        expect(v.reason).toBeInstanceOf(LibraryError)
        expect(String(v.reason.message)).toContain('novější verzi')
      }
    }

    const verze = await ownerClient.templateDocumentVersion.findMany({
      where: { templateDocumentId: zaklad.documentId },
      select: { version: true },
    })
    const cisla = verze.map((v) => v.version)
    expect(new Set(cisla).size).toBe(cisla.length)

    // Aktuální verze ukazuje na tu nejvyšší, ne na zapomenutou.
    const doc = await ownerClient.templateDocument.findUniqueOrThrow({
      where: { id: zaklad.documentId },
      select: { currentVersionId: true },
    })
    const aktualni = await ownerClient.templateDocumentVersion.findUniqueOrThrow({
      where: { id: doc.currentVersionId! },
      select: { version: true },
    })
    expect(aktualni.version).toBe(Math.max(...cisla))
  })

  it('databáze duplicitní číslo verze odmítne', async () => {
    // Tohle je ta pojistka, na kterou se výpočet čísla spoléhá.
    const zaklad = await uploadTemplateVersion(vstup({ bytes: await makePdf('Pojistka', 1) }))

    const existujici = await ownerClient.templateDocumentVersion.findFirstOrThrow({
      where: { templateDocumentId: zaklad.documentId },
    })

    await expect(
      ownerClient.templateDocumentVersion.create({
        data: {
          practiceId: a.practice.id,
          templateDocumentId: zaklad.documentId,
          version: existujici.version,
          storageKey: 'ordinace/x/sablony/duplicita.enc',
          sizeBytes: 1,
          pageCount: 1,
          sha256: 'x'.repeat(64),
          dekWrapped: Buffer.alloc(60),
          contentIv: Buffer.alloc(12),
          contentTag: Buffer.alloc(16),
          uploadedById: a.user.id,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('odmítnutí špatného vstupu', () => {
  it('soubor, který není PDF ani obrázek', async () => {
    await expect(uploadTemplateVersion(vstup({ bytes: Buffer.from('jen text') }))).rejects.toThrow(
      PdfError,
    )
  })

  it('bez určení, kam dokument patří', async () => {
    await expect(
      uploadTemplateVersion(vstup({ problemId: undefined, bytes: await makePdf('x') })),
    ).rejects.toThrow(LibraryError)
  })

  it('po odmítnutí nezůstane v databázi žádný záznam', async () => {
    const pred = await ownerClient.templateDocumentVersion.count({
      where: { practiceId: a.practice.id },
    })

    await expect(
      uploadTemplateVersion(vstup({ bytes: Buffer.from('rozbite') })),
    ).rejects.toThrow()

    expect(
      await ownerClient.templateDocumentVersion.count({ where: { practiceId: a.practice.id } }),
    ).toBe(pred)
  })
})

describe('oddělení ordinací', () => {
  it('dokument cizí ordinace nejde přečíst', async () => {
    const cizi = await uploadTemplateVersion(
      vstup({
        practiceId: b.practice.id,
        userId: b.user.id,
        userName: b.user.name,
        problemId: problemB,
        bytes: await makePdf('Cizi'),
      }),
    )

    const pokus = await withPractice(a.practice.id, (db) => readTemplateVersion(db, cizi.versionId))
    expect(pokus).toBeNull()
  })

  it('nahrání do problému cizí ordinace neprojde', async () => {
    await expect(
      uploadTemplateVersion(vstup({ problemId: problemB, bytes: await makePdf('Pokus') })),
    ).rejects.toThrow()
  })
})
