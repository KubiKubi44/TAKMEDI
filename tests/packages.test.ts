import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, withPractice } from '@/lib/db'
import { uploadTemplateVersion } from '@/lib/library-documents'
import {
  buildPackagePdf,
  createDraftPackage,
  loadPackage,
  PackageError,
  setPackageDocuments,
  uploadPackageReport,
} from '@/lib/packages'
import { inspectPdf } from '@/lib/pdf'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

let a: Awaited<ReturnType<typeof createPractice>>
let b: Awaited<ReturnType<typeof createPractice>>
let problemA: string
let verzeA: string[] = []
let cizoVerze: string

const context = { ip: null, userAgent: null }

function jakoA() {
  return { practiceId: a.practice.id, userId: a.user.id, userName: a.user.name, context }
}

beforeAll(async () => {
  a = await createPractice('Balicky A')
  b = await createPractice('Balicky B')

  problemA = (
    await ownerClient.problem.create({
      data: { practiceId: a.practice.id, name: 'Po operaci kolene', icd10: 'Z96.6' },
    })
  ).id
  const problemB = (
    await ownerClient.problem.create({ data: { practiceId: b.practice.id, name: 'Cizi' } })
  ).id

  for (const [nazev, stran] of [
    ['Pouceni', 2],
    ['Rezim', 1],
    ['Cviky', 3],
  ] as const) {
    const r = await uploadTemplateVersion({
      ...jakoA(),
      problemId: problemA,
      title: nazev,
      bytes: await makePdf(nazev, stran),
      mimeType: 'application/pdf',
    })
    verzeA.push(r.versionId)
  }

  cizoVerze = (
    await uploadTemplateVersion({
      practiceId: b.practice.id,
      userId: b.user.id,
      userName: b.user.name,
      context,
      problemId: problemB,
      title: 'Cizi dokument',
      bytes: await makePdf('Cizi', 1),
      mimeType: 'application/pdf',
    })
  ).versionId
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('sestavení balíčku', () => {
  it('nový balíček je rozpracovaný a prázdný', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })
    const view = await withPractice(a.practice.id, (db) => loadPackage(db, id))

    expect(view?.status).toBe('DRAFT')
    expect(view?.documents).toHaveLength(0)
    expect(view?.problemName).toBe('Po operaci kolene')
  })

  it('vložené dokumenty si drží pořadí a sečtou strany', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })

    const view = await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: verzeA.map((v) => ({ kind: 'TEMPLATE' as const, templateVersionId: v })),
    })

    expect(view.status).toBe('READY')
    expect(view.documents.map((d) => d.title)).toEqual(['Pouceni', 'Rezim', 'Cviky'])
    expect(view.totalPages).toBe(6)
  })

  it('jméno pacienta se uloží zašifrovaně, ale přečte se správně', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })
    await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: [{ kind: 'TEMPLATE', templateVersionId: verzeA[0]! }],
      patientLabel: 'Jan Novák',
      note: 'kontrola za týden',
    })

    const view = await withPractice(a.practice.id, (db) => loadPackage(db, id))
    expect(view?.patientLabel).toBe('Jan Novák')
    expect(view?.note).toBe('kontrola za týden')

    // V databázi nesmí být čitelné.
    const raw = await ownerClient.package.findUniqueOrThrow({
      where: { id },
      select: { patientLabelEnc: true },
    })
    expect(Buffer.from(raw.patientLabelEnc!).includes('Novák')).toBe(false)
  })

  it('opakované uložení seznam přepíše, nezdvojí', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })
    await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: verzeA.map((v) => ({ kind: 'TEMPLATE' as const, templateVersionId: v })),
    })
    const view = await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: [{ kind: 'TEMPLATE', templateVersionId: verzeA[1]! }],
    })

    expect(view.documents).toHaveLength(1)
    expect(view.documents[0]?.title).toBe('Rezim')
  })
})

describe('dodatečná změna problému', () => {
  it('problém se dá přiřadit i k balíčku, který vznikl bez něj', async () => {
    // Lékař někdy přetáhne zprávu dřív, než najde diagnózu. Balíček tou dobou
    // už existuje – bez tohohle by v historii navždy zůstal bez problému.
    const id = await createDraftPackage({ ...jakoA() })

    const pred = await withPractice(a.practice.id, (db) => loadPackage(db, id))
    expect(pred?.problemId).toBeNull()

    const view = await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: [{ kind: 'TEMPLATE', templateVersionId: verzeA[0]! }],
      problemId: problemA,
    })

    expect(view.problemId).toBe(problemA)
    expect(view.problemName).toBe('Po operaci kolene')
  })

  it('problém cizí ordinace se přiřadit nedá', async () => {
    const id = await createDraftPackage({ ...jakoA() })
    const cizi = await ownerClient.problem.findFirstOrThrow({
      where: { practiceId: b.practice.id },
      select: { id: true },
    })

    await expect(
      setPackageDocuments({
        ...jakoA(),
        packageId: id,
        items: [],
        problemId: cizi.id,
      }),
    ).rejects.toThrow(PackageError)
  })
})

describe('oddělení ordinací', () => {
  it('dokument cizí ordinace nejde do balíčku vložit', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })

    await expect(
      setPackageDocuments({
        ...jakoA(),
        packageId: id,
        items: [{ kind: 'TEMPLATE', templateVersionId: cizoVerze }],
      }),
    ).rejects.toThrow(PackageError)
  })

  it('cizí balíček nejde upravit ani načíst', async () => {
    const cizi = await createDraftPackage({
      practiceId: b.practice.id,
      userId: b.user.id,
      userName: b.user.name,
      context,
    })

    await expect(
      setPackageDocuments({ ...jakoA(), packageId: cizi, items: [] }),
    ).rejects.toThrow(PackageError)

    const pokus = await withPractice(a.practice.id, (db) => loadPackage(db, cizi))
    expect(pokus).toBeNull()
  })
})

describe('lékařská zpráva', () => {
  it('nahraje se, připojí k balíčku a dá se vložit mezi dokumenty', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })

    const zprava = await uploadPackageReport({
      ...jakoA(),
      packageId: id,
      bytes: await makePdf('Lekarska zprava', 1),
      mimeType: 'application/pdf',
    })
    expect(zprava.pageCount).toBe(1)

    const view = await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: [
        { kind: 'UPLOAD', uploadedFileId: zprava.uploadedFileId },
        { kind: 'TEMPLATE', templateVersionId: verzeA[0]! },
      ],
    })

    expect(view.documents.map((d) => d.kind)).toEqual(['UPLOAD', 'TEMPLATE'])
    expect(view.documents[0]?.title).toBe('Lékařská zpráva')
  })

  it('soubor, který není PDF ani obrázek, se odmítne', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })

    await expect(
      uploadPackageReport({
        ...jakoA(),
        packageId: id,
        bytes: Buffer.from('jen text'),
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow()
  })
})

describe('sloučení k tisku', () => {
  it('spojí dokumenty v pořadí a sečte strany', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })
    await setPackageDocuments({
      ...jakoA(),
      packageId: id,
      items: verzeA.map((v) => ({ kind: 'TEMPLATE' as const, templateVersionId: v })),
    })

    const merged = await withPractice(a.practice.id, (db) => buildPackagePdf(db, id), {
      timeoutMs: 60_000,
    })

    expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await inspectPdf(merged)).toEqual({ pageCount: 6 })
  })

  it('prázdný balíček se tisknout nedá', async () => {
    const id = await createDraftPackage({ ...jakoA(), problemId: problemA })

    await expect(
      withPractice(a.practice.id, (db) => buildPackagePdf(db, id)),
    ).rejects.toThrow(PackageError)
  })
})
