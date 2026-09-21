import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { revokePackageLinks, runCleanup } from '@/lib/cleanup'
import { appClient, resolverClient, withPractice } from '@/lib/db'
import { activateHandoff, claimHandoff, type ResolvedPractice } from '@/lib/handoff'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { createDraftPackage, setPackageDocuments, uploadPackageReport } from '@/lib/packages'
import { openPatientPackage, PatientAccessError } from '@/lib/patient'
import { storage } from '@/lib/storage'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

/**
 * Úklid po expiraci.
 *
 * Testuje slib daný pacientovi: po uplynutí platnosti se dokumenty opravdu
 * smažou – z úložiště, ne jen z pohledu aplikace. A zároveň to, co zůstat
 * musí: audit a záznam, že se něco předalo.
 */

const context = { ip: null, userAgent: null }

let a: Awaited<ReturnType<typeof createPractice>>
let practiceA: ResolvedPractice
let verze: string

async function balicekSeZpravou() {
  const id = await createDraftPackage({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    context,
  })
  const zprava = await uploadPackageReport({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    packageId: id,
    bytes: await makePdf('Zprava', 1),
    mimeType: 'application/pdf',
    context,
  })
  await setPackageDocuments({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    packageId: id,
    items: [
      { kind: 'TEMPLATE', templateVersionId: verze },
      { kind: 'UPLOAD', uploadedFileId: zprava.uploadedFileId },
    ],
    patientLabel: 'Jan Novák',
    context,
  })
  return id
}

beforeAll(async () => {
  a = await createPractice('Uklid A')
  const problem = await ownerClient.problem.create({
    data: { practiceId: a.practice.id, name: 'Po operaci kolene' },
  })
  verze = (
    await uploadTemplateVersion({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      problemId: problem.id,
      title: 'Pouceni',
      bytes: await makePdf('Pouceni', 2),
      mimeType: 'application/pdf',
      context,
    })
  ).versionId

  practiceA = {
    id: a.practice.id,
    name: a.practice.name,
    addressLine: null,
    handoffTtlSeconds: 180,
    maxCodeAttempts: 5,
    linkTtlDays: 30,
  }
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
  await resolverClient.$disconnect()
})

describe('expirace balíčku', () => {
  it('smaže obsah z ÚLOŽIŠTĚ, ne jen z pohledu aplikace', async () => {
    const packageId = await balicekSeZpravou()
    const aktivace = await activateHandoff({
      practiceId: a.practice.id,
      packageId,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    const { token } = await claimHandoff({
      practice: practiceA,
      tagId: null,
      code: aktivace.code,
      context,
    })

    const soubor = await ownerClient.uploadedFile.findFirstOrThrow({ where: { packageId } })
    expect(await (await storage()).exists(soubor.storageKey)).toBe(true)

    await ownerClient.package.update({
      where: { id: packageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await runCleanup()

    // Tohle je ten slib: obsah je pryč z úložiště.
    expect(await (await storage()).exists(soubor.storageKey)).toBe(false)

    const po = await ownerClient.package.findUniqueOrThrow({ where: { id: packageId } })
    expect(po.status).toBe('EXPIRED')
    expect(po.purgedAt).not.toBeNull()
    // Jméno pacienta zmizelo taky.
    expect(po.patientLabelEnc).toBeNull()

    // A odkaz přestal fungovat.
    await expect(openPatientPackage(token, context)).rejects.toThrow(PatientAccessError)
  })

  it('audit expirovaného balíčku zůstane', async () => {
    // Co se předalo, se dohledat musí. Jen ne komu a co přesně.
    const packageId = await balicekSeZpravou()
    await ownerClient.package.update({
      where: { id: packageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await runCleanup()

    const zaznamy = await ownerClient.auditLog.findMany({
      where: { packageId },
      select: { action: true },
    })
    expect(zaznamy.map((z) => z.action)).toContain('PACKAGE_CREATED')
    expect(zaznamy.map((z) => z.action)).toContain('FILES_PURGED')
  })

  it('jde spustit opakovaně, aniž by něco pokazil', async () => {
    const packageId = await balicekSeZpravou()
    await ownerClient.package.update({
      where: { id: packageId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const prvni = await runCleanup()
    const druhy = await runCleanup()

    expect(prvni.chyby).toHaveLength(0)
    expect(druhy.chyby).toHaveLength(0)
    // Podruhé už není co uklízet.
    expect(druhy.balicku).toBe(0)
  })

  it('nevypršelý balíček zůstane nedotčený', async () => {
    const packageId = await balicekSeZpravou()
    await ownerClient.package.update({
      where: { id: packageId },
      data: { expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    })

    await runCleanup()

    const po = await ownerClient.package.findUniqueOrThrow({ where: { id: packageId } })
    expect(po.purgedAt).toBeNull()
    expect(po.patientLabelEnc).not.toBeNull()
  })
})

describe('opuštěné rozpracované balíčky', () => {
  it('starší než den se smažou i s obsahem', async () => {
    const packageId = await createDraftPackage({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    await uploadPackageReport({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      packageId,
      bytes: await makePdf('Opustena', 1),
      mimeType: 'application/pdf',
      context,
    })

    const soubor = await ownerClient.uploadedFile.findFirstOrThrow({ where: { packageId } })

    await ownerClient.package.update({
      where: { id: packageId },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
    })

    await runCleanup()

    expect(await ownerClient.package.findUnique({ where: { id: packageId } })).toBeNull()
    expect(await (await storage()).exists(soubor.storageKey)).toBe(false)
  })

  it('čerstvý rozpracovaný balíček zůstane', async () => {
    const packageId = await createDraftPackage({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })

    await runCleanup()

    expect(await ownerClient.package.findUnique({ where: { id: packageId } })).not.toBeNull()
  })
})

describe('ruční zneplatnění', () => {
  it('odkaz přestane fungovat okamžitě', async () => {
    const packageId = await balicekSeZpravou()
    const aktivace = await activateHandoff({
      practiceId: a.practice.id,
      packageId,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    const { token } = await claimHandoff({
      practice: practiceA,
      tagId: null,
      code: aktivace.code,
      context,
    })

    expect(await openPatientPackage(token, context)).toBeTruthy()

    const pocet = await revokePackageLinks({
      practiceId: a.practice.id,
      packageId,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    expect(pocet).toBe(1)

    await expect(openPatientPackage(token, context)).rejects.toThrow(PatientAccessError)

    const po = await ownerClient.package.findUniqueOrThrow({ where: { id: packageId } })
    expect(po.status).toBe('REVOKED')
  })
})

describe('aktivace a relace', () => {
  it('vypršelá aktivace se přepne na EXPIRED', async () => {
    const packageId = await balicekSeZpravou()
    const aktivace = await activateHandoff({
      practiceId: a.practice.id,
      packageId,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })

    await ownerClient.handoffActivation.update({
      where: { id: aktivace.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await runCleanup()

    const po = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: aktivace.id } })
    expect(po.status).toBe('EXPIRED')
  })
})
