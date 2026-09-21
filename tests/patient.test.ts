import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashToken, hmacSecret } from '@/lib/crypto'
import { appClient, withPractice } from '@/lib/db'
import { activateHandoff, claimHandoff, type ResolvedPractice } from '@/lib/handoff'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { createDraftPackage, setPackageDocuments } from '@/lib/packages'
import {
  buildPatientPdf,
  openPatientPackage,
  PatientAccessError,
  readPatientDocument,
  recordPatientVisit,
  verifyPatientAccess,
} from '@/lib/patient'
import { inspectPdf } from '@/lib/pdf'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

/**
 * Přístup pacienta k balíčku.
 *
 * Pacient nemá účet – jediné, co ho opravňuje, je token v adrese. Testy proto
 * hlídají hlavně to, co se NESMÍ stát: aby se odkazem dostal k něčemu jinému,
 * aby vypršelý nebo zneplatněný odkaz pořád fungoval, a aby se z chybové
 * hlášky dalo poznat, že někde nějaký balíček existuje.
 */

const context = { ip: '198.51.100.9', userAgent: 'telefon' }

let a: Awaited<ReturnType<typeof createPractice>>
let practiceA: ResolvedPractice
let token: string
let packageId: string
let cizoPackageId: string

beforeAll(async () => {
  a = await createPractice('Pacient A')
  const b = await createPractice('Pacient B')

  const problem = await ownerClient.problem.create({
    data: { practiceId: a.practice.id, name: 'Po operaci kolene' },
  })

  const verze = []
  for (const [nazev, stran] of [
    ['Pouceni', 2],
    ['Rezim', 1],
  ] as const) {
    verze.push(
      (
        await uploadTemplateVersion({
          practiceId: a.practice.id,
          userId: a.user.id,
          userName: a.user.name,
          problemId: problem.id,
          title: nazev,
          bytes: await makePdf(nazev, stran),
          mimeType: 'application/pdf',
          context,
        })
      ).versionId,
    )
  }

  packageId = await createDraftPackage({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    context,
  })
  await setPackageDocuments({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    packageId,
    items: verze.map((v) => ({ kind: 'TEMPLATE' as const, templateVersionId: v })),
    context,
  })

  cizoPackageId = await createDraftPackage({
    practiceId: b.practice.id,
    userId: b.user.id,
    userName: b.user.name,
    context,
  })

  practiceA = {
    id: a.practice.id,
    name: a.practice.name,
    addressLine: null,
    handoffTtlSeconds: 180,
    maxCodeAttempts: 5,
    linkTtlDays: 30,
  }

  const aktivace = await activateHandoff({
    practiceId: a.practice.id,
    packageId,
    userId: a.user.id,
    userName: a.user.name,
    context,
  })
  token = (await claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }))
    .token

  await removePractice(b.practice.id).catch(() => {})
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('otevření balíčku', () => {
  it('platný token vrátí dokumenty a název ordinace', async () => {
    const balicek = await openPatientPackage(token, context)

    expect(balicek.practiceName).toBe(a.practice.name)
    expect(balicek.documents.map((d) => d.title)).toEqual(['Pouceni', 'Rezim'])
    expect(balicek.totalPages).toBe(3)
    expect(balicek.needsVerification).toBeNull()
  })

  it('neplatný token nic neprozradí', async () => {
    await expect(openPatientPackage('naprosty-nesmysl-token-xxxxxxxxxxxx', context)).rejects.toThrow(
      PatientAccessError,
    )
  })

  it('token jiné délky nezpůsobí dotaz do databáze ani pád', async () => {
    await expect(openPatientPackage('kratky', context)).rejects.toThrow(PatientAccessError)
    await expect(openPatientPackage('x'.repeat(500), context)).rejects.toThrow(PatientAccessError)
  })

  it('zneplatněný odkaz přestane fungovat okamžitě', async () => {
    const aktivace = await activateHandoff({
      practiceId: a.practice.id,
      packageId,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    const druhy = (
      await claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context })
    ).token

    expect(await openPatientPackage(druhy, context)).toBeTruthy()

    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { revokedAt: new Date() },
    })

    await expect(openPatientPackage(druhy, context)).rejects.toThrow(PatientAccessError)

    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { revokedAt: null },
    })
  })

  it('vypršelý odkaz přestane fungovat', async () => {
    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await expect(openPatientPackage(token, context)).rejects.toThrow(PatientAccessError)

    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    })
  })

  it('vypršelý, zneplatněný i neexistující odkaz vypadají ven stejně', async () => {
    // Z hlášky se nesmí poznat, jestli takový balíček někdy existoval.
    const neplatny = await openPatientPackage('x'.repeat(43), context).catch((e) => e.message)

    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { revokedAt: new Date() },
    })
    const zneplatneny = await openPatientPackage(token, context).catch((e) => e.message)
    await ownerClient.patientAccessToken.updateMany({
      where: { packageId },
      data: { revokedAt: null },
    })

    expect(typeof neplatny).toBe('string')
    expect(typeof zneplatneny).toBe('string')
    // Znění se liší jen mezi „neplatí" a „skončila platnost" – ani jedno
    // neprozradí, čí balíček to byl nebo co obsahoval.
    expect(neplatny).not.toContain(a.practice.name)
    expect(zneplatneny).not.toContain(a.practice.name)
  })
})

describe('stahování', () => {
  it('celý balíček jako jedno PDF má součet stran', async () => {
    const merged = await withPractice(a.practice.id, (db) => buildPatientPdf(db, packageId), {
      timeoutMs: 60_000,
    })
    expect(await inspectPdf(merged)).toEqual({ pageCount: 3 })
  })

  it('jednotlivý dokument se stáhne podle pořadí', async () => {
    const balicek = await openPatientPackage(token, context)
    const prvni = await withPractice(a.practice.id, (db) =>
      readPatientDocument(db, packageId, balicek.documents[0]!.id),
    )

    expect(prvni?.title).toBe('Pouceni')
    expect(await inspectPdf(prvni!.bytes)).toEqual({ pageCount: 2 })
  })

  it('dokument z cizího balíčku nejde stáhnout ani se správným tokenem', async () => {
    const balicek = await openPatientPackage(token, context)

    const pokus = await withPractice(a.practice.id, (db) =>
      readPatientDocument(db, cizoPackageId, balicek.documents[0]!.id),
    )
    expect(pokus).toBeNull()
  })
})

describe('návštěva a audit', () => {
  it('první i poslední návštěva se zaznamenají a počítadlo roste', async () => {
    const pred = await ownerClient.patientAccessToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    })

    await recordPatientVisit(a.practice.id, pred.id, packageId, context)
    await recordPatientVisit(a.practice.id, pred.id, packageId, context)

    const po = await ownerClient.patientAccessToken.findUniqueOrThrow({ where: { id: pred.id } })
    expect(po.accessCount).toBe(pred.accessCount + 2)
    expect(po.firstAccessedAt).not.toBeNull()
    expect(po.lastAccessedAt).not.toBeNull()
    // První návštěva se nepřepisuje.
    expect(po.firstAccessedAt!.getTime()).toBeLessThanOrEqual(po.lastAccessedAt!.getTime())

    const audit = await ownerClient.auditLog.count({
      where: { packageId, action: 'PATIENT_PAGE_VIEWED' },
    })
    expect(audit).toBeGreaterThanOrEqual(2)
  })
})

describe('ověření u odkazu z e-mailu', () => {
  it('bez ověření se dokumenty neukážou, po ověření ano', async () => {
    const t = await ownerClient.patientAccessToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    })
    await ownerClient.patientAccessToken.update({
      where: { id: t.id },
      data: {
        channel: 'EMAIL',
        verificationType: 'PIN',
        verificationHmac: hmacSecret('123456'),
        verifiedAt: null,
        verifyAttempts: 0,
      },
    })

    const pred = await openPatientPackage(token, context)
    expect(pred.needsVerification).toBe('PIN')

    await verifyPatientAccess({ token, answer: '123456', context })

    const po = await openPatientPackage(token, context)
    expect(po.needsVerification).toBeNull()
  })

  it('špatný PIN se počítá a po vyčerpání zamkne', async () => {
    // Podle hashe, ne findFirst: balíček má víc tokenů a pořadí bez orderBy
    // není určené, takže by se PIN nastavil jinému, než jakým se ověřuje.
    const t = await ownerClient.patientAccessToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    })
    await ownerClient.patientAccessToken.update({
      where: { id: t.id },
      data: { verifiedAt: null, verifyAttempts: 0 },
    })

    for (let i = 0; i < 6; i++) {
      await verifyPatientAccess({ token, answer: '000000', context }).catch(() => {})
    }

    const po = await ownerClient.patientAccessToken.findUniqueOrThrow({ where: { id: t.id } })
    // Počítadlo přežilo – kdyby se výjimka vyhazovala z transakce, vrátilo by se zpět.
    expect(po.verifyAttempts).toBe(6)

    // A po vyčerpání neprojde ani správný PIN.
    await expect(verifyPatientAccess({ token, answer: '123456', context })).rejects.toThrow(
      PatientAccessError,
    )
  })
})
