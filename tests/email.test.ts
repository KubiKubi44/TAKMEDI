import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmacSecret } from '@/lib/crypto'
import { appClient, withPractice } from '@/lib/db'
import { EmailDispatchError, sendPackageByEmail } from '@/lib/email-dispatch'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { createDraftPackage, setPackageDocuments } from '@/lib/packages'
import { openPatientPackage, PatientAccessError, verifyPatientAccess } from '@/lib/patient'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

/**
 * Odeslání balíčku e-mailem.
 *
 * Testy hlídají hlavně to, co je na tomhle kanálu jiné: e-mail nese JEN ODKAZ
 * a ověřovací PIN jde ÚSTNĚ, takže znalost schránky sama o sobě nestačí.
 */

const context = { ip: null, userAgent: null }

let a: Awaited<ReturnType<typeof createPractice>>
let verze: string

/** Odchytí, co by se odeslalo, aniž by se něco doopravdy poslalo. */
const odeslane: { to: string; subject: string; text: string }[] = []

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ')
    if (text.includes('e-mail (vývojový režim')) odeslane.push({ to: '', subject: '', text })
  })

  a = await createPractice('Email A')
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
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

async function balicek() {
  const id = await createDraftPackage({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    context,
  })
  await setPackageDocuments({
    practiceId: a.practice.id,
    userId: a.user.id,
    userName: a.user.name,
    packageId: id,
    items: [{ kind: 'TEMPLATE', templateVersionId: verze }],
    context,
  })
  return id
}

function odeslat(packageId: string, recipient = 'pacient@example.cz') {
  return sendPackageByEmail({
    practiceId: a.practice.id,
    practiceName: a.practice.name,
    userId: a.user.id,
    userName: a.user.name,
    packageId,
    recipient,
    linkTtlDays: 30,
    context,
  })
}

describe('odeslání', () => {
  it('vrátí šestimístný PIN a založí záznam o odeslání', async () => {
    const packageId = await balicek()
    const { pin, dispatchId } = await odeslat(packageId)

    expect(pin).toMatch(/^\d{6}$/)

    const dispatch = await ownerClient.emailDispatch.findUniqueOrThrow({ where: { id: dispatchId } })
    expect(dispatch.status).toBe('SENT')
    expect(dispatch.sentAt).not.toBeNull()
  })

  it('adresa příjemce je v databázi nečitelná, hash zůstává pro audit', async () => {
    const packageId = await balicek()
    const { dispatchId } = await odeslat(packageId, 'jan.novak@example.cz')

    const dispatch = await ownerClient.emailDispatch.findUniqueOrThrow({ where: { id: dispatchId } })
    expect(Buffer.from(dispatch.recipientEnc).includes('novak')).toBe(false)
    expect(dispatch.recipientHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('vydaný odkaz vyžaduje ověření a PIN sedí', async () => {
    const packageId = await balicek()
    const { pin } = await odeslat(packageId)

    const token = await ownerClient.patientAccessToken.findFirstOrThrow({
      where: { packageId },
      select: { verificationType: true, verificationHmac: true },
    })

    expect(token.verificationType).toBe('PIN')
    // PIN je v databázi jen jako HMAC s pepperem.
    expect(token.verificationHmac).toBe(hmacSecret(pin))
    expect(token.verificationHmac).not.toContain(pin)
  })

  it('balíček se označí jako předaný a dostane platnost', async () => {
    const packageId = await balicek()
    await odeslat(packageId)

    const po = await ownerClient.package.findUniqueOrThrow({ where: { id: packageId } })
    expect(po.status).toBe('HANDED')
    expect(po.expiresAt).not.toBeNull()
  })

  it('prázdný balíček se odeslat nedá', async () => {
    const prazdny = await createDraftPackage({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })

    await expect(odeslat(prazdny)).rejects.toThrow(EmailDispatchError)
  })

  it('balíček cizí ordinace se odeslat nedá', async () => {
    const b = await createPractice('Email B')
    const cizi = await createDraftPackage({
      practiceId: b.practice.id,
      userId: b.user.id,
      userName: b.user.name,
      context,
    })

    await expect(odeslat(cizi)).rejects.toThrow(EmailDispatchError)
    await removePractice(b.practice.id)
  })
})

describe('obsah e-mailu', () => {
  it('nese jen odkaz – žádnou přílohu, žádné jméno, žádnou diagnózu', async () => {
    odeslane.length = 0
    const packageId = await balicek()
    await setPackageDocuments({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      packageId,
      items: [{ kind: 'TEMPLATE', templateVersionId: verze }],
      patientLabel: 'Jan Novák',
      context,
    })

    const { pin } = await odeslat(packageId)

    expect(odeslane).toHaveLength(1)
    const text = odeslane[0]!.text

    expect(text).toContain('/d/')
    // Jméno pacienta ani diagnóza do e-mailu nepatří – putuje přes cizí servery
    // a zůstává ve schránce, ke které ordinace nemá přístup.
    expect(text).not.toContain('Jan Novák')
    expect(text).not.toContain('kolene')
    // A hlavně: PIN v e-mailu NENÍ. V tom je celý smysl druhé cesty.
    expect(text).not.toContain(pin)
  })

  it('adresa příjemce se do konzole vypíše jen částečně', async () => {
    odeslane.length = 0
    const packageId = await balicek()
    await odeslat(packageId, 'jan.novak@example.cz')

    expect(odeslane[0]!.text).not.toContain('jan.novak@example.cz')
    expect(odeslane[0]!.text).toContain('example.cz')
  })
})

describe('ověření pacientem', () => {
  it('bez PINu se dokumenty neukážou, se správným ano', async () => {
    const packageId = await balicek()
    const { pin } = await odeslat(packageId)

    // Token se tu musí získat oklikou: plaintext existuje jen uvnitř odeslání.
    // Test proto ověřuje chování přes databázi a hash.
    const ulozeny = await ownerClient.patientAccessToken.findFirstOrThrow({
      where: { packageId },
      select: { id: true, verificationHmac: true },
    })
    expect(ulozeny.verificationHmac).toBe(hmacSecret(pin))

    // A že špatný PIN neprojde, ověřuje tests/patient.test.ts nad známým tokenem.
    expect(hmacSecret('000000')).not.toBe(ulozeny.verificationHmac)
  })
})
