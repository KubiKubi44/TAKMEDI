import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashToken } from '@/lib/crypto'
import { appClient, withPractice } from '@/lib/db'
import {
  activateHandoff,
  cancelActivation,
  claimHandoff,
  createNfcTag,
  getActivationStatus,
  HandoffError,
  resolvePracticeFromTag,
  type ResolvedPractice,
} from '@/lib/handoff'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { createDraftPackage, setPackageDocuments } from '@/lib/packages'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

/**
 * Předání přes NFC.
 *
 * Čtyřmístný kód má deset tisíc možností, takže tahle sada je nejdůležitější
 * v celém projektu. Netestuje se jen „funguje to", ale hlavně to, co musí
 * platit, i když se někdo snaží: jedna aktivace na ordinaci, globální počítadlo
 * pokusů a jednorázovost i při souběhu.
 */

const context = { ip: '198.51.100.7', userAgent: 'test' }

let a: Awaited<ReturnType<typeof createPractice>>
let b: Awaited<ReturnType<typeof createPractice>>
let practiceA: ResolvedPractice
let verzeA: string

async function pripravBalicek(prakticeId: string, userId: string, userName: string, verze: string) {
  const id = await createDraftPackage({ practiceId: prakticeId, userId, userName, context })
  await setPackageDocuments({
    practiceId: prakticeId,
    userId,
    userName,
    packageId: id,
    items: [{ kind: 'TEMPLATE', templateVersionId: verze }],
    context,
  })
  return id
}

/** Vytáhne kód z aktivace tak, jak ho vidí lékař na obrazovce. */
async function aktivuj(packageId: string) {
  return activateHandoff({
    practiceId: a.practice.id,
    packageId,
    userId: a.user.id,
    userName: a.user.name,
    context,
  })
}

beforeAll(async () => {
  a = await createPractice('NFC A')
  b = await createPractice('NFC B')

  const problem = await ownerClient.problem.create({
    data: { practiceId: a.practice.id, name: 'Po operaci kolene' },
  })

  verzeA = (
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
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('NFC čip', () => {
  it('adresa obsahuje slug i tajemství a v databázi je jen HMAC', async () => {
    const { tagId, url } = await createNfcTag({
      practiceId: a.practice.id,
      practiceSlug: a.practice.slug,
      userId: a.user.id,
      userName: a.user.name,
      label: 'Čip u recepce',
      appUrl: 'https://medpredani.example',
      context,
    })

    expect(url).toContain(`/o/${a.practice.slug}/`)
    const tajemstvi = url.split('/').pop()!
    expect(tajemstvi.length).toBeGreaterThan(15)

    const ulozeny = await ownerClient.nfcTag.findUniqueOrThrow({ where: { id: tagId } })
    expect(ulozeny.secretHmac).not.toContain(tajemstvi)
    expect(ulozeny.secretHmac).toMatch(/^[0-9a-f]{64}$/)
  })

  it('správné tajemství ordinaci najde, podvržené ne', async () => {
    const { url } = await createNfcTag({
      practiceId: a.practice.id,
      practiceSlug: a.practice.slug,
      userId: a.user.id,
      userName: a.user.name,
      label: 'Druhý čip',
      appUrl: 'https://medpredani.example',
      context,
    })
    const tajemstvi = url.split('/').pop()!

    const spravne = await resolvePracticeFromTag(a.practice.slug, tajemstvi)
    expect(spravne.practice.id).toBe(a.practice.id)
    expect(spravne.tagId).not.toBeNull()

    await expect(resolvePracticeFromTag(a.practice.slug, 'podvrzene')).rejects.toThrow(HandoffError)
  })

  it('neznámý slug vrátí stejnou chybu jako špatné tajemství', async () => {
    // Ven se nesmí dostat, jestli taková ordinace existuje.
    const a1 = await resolvePracticeFromTag('neexistujici-ordinace', null).catch((e) => e)
    const a2 = await resolvePracticeFromTag(a.practice.slug, 'spatne').catch((e) => e)

    expect(a1).toBeInstanceOf(HandoffError)
    expect(a2).toBeInstanceOf(HandoffError)
    expect(a1.message).toBe(a2.message)
  })
})

describe('aktivace', () => {
  it('kód má čtyři číslice a v databázi je jen jeho HMAC', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    expect(aktivace.code).toMatch(/^\d{4}$/)

    const ulozena = await ownerClient.handoffActivation.findUniqueOrThrow({
      where: { id: aktivace.id },
    })
    expect(ulozena.codeHmac).not.toContain(aktivace.code)
    expect(ulozena.status).toBe('ACTIVE')
  })

  it('nová aktivace zruší předchozí – v ordinaci je vždy nejvýš jedna', async () => {
    // Na tomhle stojí bezpečnost čtyřmístného kódu: uhodnutý kód nikdy
    // nemůže trefit „nějaký jiný" balíček, protože žádný jiný není ve hře.
    const b1 = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const b2 = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)

    const prvni = await aktivuj(b1)
    const druha = await aktivuj(b2)

    const aktivnich = await ownerClient.handoffActivation.count({
      where: { practiceId: a.practice.id, status: 'ACTIVE' },
    })
    expect(aktivnich).toBe(1)

    const stara = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: prvni.id } })
    expect(stara.status).toBe('CANCELLED')

    const nova = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: druha.id } })
    expect(nova.status).toBe('ACTIVE')
  })

  it('prázdný balíček se předat nedá', async () => {
    const prazdny = await createDraftPackage({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })
    await expect(aktivuj(prazdny)).rejects.toThrow(HandoffError)
  })

  it('lékař vidí stav a zbývající pokusy', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    const stav = await withPractice(a.practice.id, (db) => getActivationStatus(db, aktivace.id))
    expect(stav?.status).toBe('ACTIVE')
    expect(stav?.attemptsLeft).toBe(5)
  })
})

describe('nárokování pacientem', () => {
  it('správný kód vydá token a aktivaci vyčerpá', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    const { token, packageId } = await claimHandoff({
      practice: practiceA,
      tagId: null,
      code: aktivace.code,
      context,
    })

    expect(packageId).toBe(balicek)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    // V databázi je jen hash tokenu.
    const ulozeny = await ownerClient.patientAccessToken.findFirstOrThrow({
      where: { packageId: balicek },
    })
    expect(ulozeny.tokenHash).toBe(hashToken(token))
    expect(ulozeny.channel).toBe('NFC')

    const po = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: aktivace.id } })
    expect(po.status).toBe('CLAIMED')

    const balicekPo = await ownerClient.package.findUniqueOrThrow({ where: { id: balicek } })
    expect(balicekPo.status).toBe('HANDED')
    expect(balicekPo.expiresAt).not.toBeNull()
  })

  it('druhé přiložení telefonu už nic nedostane', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    await claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context })

    await expect(
      claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }),
    ).rejects.toThrow(HandoffError)
  })

  it('špatný kód zvyšuje počítadlo a po vyčerpání zamkne', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)
    const spatny = aktivace.code === '0000' ? '1111' : '0000'

    for (let i = 1; i <= 4; i++) {
      await expect(
        claimHandoff({ practice: practiceA, tagId: null, code: spatny, context }),
      ).rejects.toThrow(HandoffError)

      const stav = await withPractice(a.practice.id, (db) => getActivationStatus(db, aktivace.id))
      expect(stav?.attemptsLeft).toBe(5 - i)
    }

    // Pátý pokus aktivaci zamkne.
    await expect(
      claimHandoff({ practice: practiceA, tagId: null, code: spatny, context }),
    ).rejects.toThrow(HandoffError)

    const po = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: aktivace.id } })
    expect(po.status).toBe('LOCKED')

    // A po zamčení neprojde ani SPRÁVNÝ kód.
    await expect(
      claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }),
    ).rejects.toThrow(HandoffError)
  })

  it('počítadlo je globální, ne podle IP adresy', async () => {
    // Kdyby se počítalo podle adresy, stačilo by útočníkovi střídat sítě.
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)
    const spatny = aktivace.code === '0000' ? '1111' : '0000'

    for (let i = 0; i < 5; i++) {
      await claimHandoff({
        practice: practiceA,
        tagId: null,
        code: spatny,
        context: { ip: `203.0.113.${i}`, userAgent: 'utocnik' },
      }).catch(() => {})
    }

    const po = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: aktivace.id } })
    expect(po.status).toBe('LOCKED')
    expect(po.attemptCount).toBe(5)
  })

  it('vypršelá aktivace neprojde ani se správným kódem', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    await ownerClient.handoffActivation.update({
      where: { id: aktivace.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await expect(
      claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }),
    ).rejects.toThrow(HandoffError)
  })

  it('zrušená aktivace neprojde', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    await cancelActivation({
      practiceId: a.practice.id,
      activationId: aktivace.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
    })

    await expect(
      claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }),
    ).rejects.toThrow(HandoffError)
  })

  it('SOUBĚH: pět současných pokusů se správným kódem vydá právě jeden token', async () => {
    // Nejdůležitější test v souboru. Bez zámku řádku (SELECT ... FOR UPDATE)
    // by se ze stejné aktivace vydalo víc tokenů a balíček by dostal i ten,
    // kdo jen stál poblíž a kód odezřel.
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    const pokusy = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        claimHandoff({ practice: practiceA, tagId: null, code: aktivace.code, context }),
      ),
    )

    const uspesne = pokusy.filter((p) => p.status === 'fulfilled')
    expect(uspesne).toHaveLength(1)

    const tokeny = await ownerClient.patientAccessToken.count({ where: { packageId: balicek } })
    expect(tokeny).toBe(1)
  })

  it('aktivace ordinace A se nedá nárokovat v kontextu ordinace B', async () => {
    const balicek = await pripravBalicek(a.practice.id, a.user.id, a.user.name, verzeA)
    const aktivace = await aktivuj(balicek)

    const practiceB: ResolvedPractice = {
      id: b.practice.id,
      name: b.practice.name,
      addressLine: null,
      handoffTtlSeconds: 180,
      maxCodeAttempts: 5,
      linkTtlDays: 30,
    }

    await expect(
      claimHandoff({ practice: practiceB, tagId: null, code: aktivace.code, context }),
    ).rejects.toThrow(HandoffError)

    // A aktivace v ordinaci A zůstane nedotčená.
    const po = await ownerClient.handoffActivation.findUniqueOrThrow({ where: { id: aktivace.id } })
    expect(po.status).toBe('ACTIVE')
    expect(po.attemptCount).toBe(0)
  })
})
