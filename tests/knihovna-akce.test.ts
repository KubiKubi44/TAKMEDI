import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, withPractice } from '@/lib/db'
import { getPreselectedDocuments, getProblemDetail } from '@/lib/library'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { createPractice, ownerClient, removePractice } from './helpers'
import { makePdf } from './fixtures/pdf'

/**
 * Úpravy knihovny: přejmenování, archivace, pořadí a verzování.
 *
 * Testuje se to, co po úpravě VIDÍ zbytek aplikace, tedy getProblemDetail
 * a getPreselectedDocuments. Server Actions se sem nevolají – potřebují
 * požadavek (session, cookie, kontrola původu), takže by test místo knihovny
 * ověřoval Next.js. Vlastní změnu proto dělá přímý dotaz uvnitř withPractice,
 * úplně stejně jako uvnitř akce.
 */

type Ordinace = Awaited<ReturnType<typeof createPractice>>

let a: Ordinace
let b: Ordinace
/** Problém cizí ordinace. Slouží ke kontrole, že se přes jeho id nedá nic získat. */
let problemB: string

const context = { ip: null, userAgent: null }

beforeAll(async () => {
  a = await createPractice('Knihovna akce A')
  b = await createPractice('Knihovna akce B')
  problemB = await zalozProblem(b, 'Cizí problém')
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

/**
 * Každý test má vlastní problém. Sdílený by znamenal, že pořadí dokumentů
 * v jednom testu závisí na tom, co udělal předchozí.
 */
async function zalozProblem(ordinace: Ordinace, name: string): Promise<string> {
  const problem = await ownerClient.problem.create({
    data: { practiceId: ordinace.practice.id, name },
  })
  return problem.id
}

/** Nahraje skutečné PDF stejnou cestou jako lékař u obrazovky. */
async function nahraj(
  ordinace: Ordinace,
  kam: { problemId: string } | { documentId: string },
  title: string,
  pages = 1,
) {
  return uploadTemplateVersion({
    practiceId: ordinace.practice.id,
    userId: ordinace.user.id,
    userName: ordinace.user.name,
    ...kam,
    title,
    bytes: await makePdf(title, pages),
    mimeType: 'application/pdf',
    context,
  })
}

function detail(ordinace: Ordinace, problemId: string) {
  return withPractice(ordinace.practice.id, (db) => getProblemDetail(db, problemId))
}

function predvyber(ordinace: Ordinace, problemId: string) {
  return withPractice(ordinace.practice.id, (db) => getPreselectedDocuments(db, problemId))
}

describe('přejmenování dokumentu', () => {
  it('nový název se objeví v detailu problému', async () => {
    const problemId = await zalozProblem(a, 'Přejmenování')
    const nahrany = await nahraj(a, { problemId }, 'Nazev-souboru-z-tiskarny')

    await withPractice(a.practice.id, (db) =>
      db.templateDocument.update({
        where: { id: nahrany.documentId },
        data: { title: 'Poučení po operaci kolene' },
      }),
    )

    const po = await detail(a, problemId)
    expect(po?.documents.map((d) => d.title)).toEqual(['Poučení po operaci kolene'])
  })

  it('přejmenování nesáhne na obsah ani na verzi', async () => {
    const problemId = await zalozProblem(a, 'Přejmenování bez dopadu')
    const nahrany = await nahraj(a, { problemId }, 'Puvodni', 3)

    await withPractice(a.practice.id, (db) =>
      db.templateDocument.update({
        where: { id: nahrany.documentId },
        data: { title: 'Nový název' },
      }),
    )

    const dokument = (await detail(a, problemId))?.documents[0]
    expect(dokument?.currentVersionId).toBe(nahrany.versionId)
    expect(dokument?.version).toBe(1)
    expect(dokument?.pageCount).toBe(3)
  })
})

describe('archivace dokumentu', () => {
  it('archivovaný se nepředvybírá, ale v knihovně zůstane', async () => {
    const problemId = await zalozProblem(a, 'Archivace')
    const zustava = await nahraj(a, { problemId }, 'Platný leták')
    const konci = await nahraj(a, { problemId }, 'Leták z loňska')

    await withPractice(a.practice.id, (db) =>
      db.templateDocument.update({
        where: { id: konci.documentId },
        data: { archivedAt: new Date() },
      }),
    )

    expect((await predvyber(a, problemId)).map((d) => d.documentId)).toEqual([zustava.documentId])

    // V knihovně se archivovaný dokument pořád ukáže – ordinace musí vidět,
    // co pacientům kdy dala.
    const po = await detail(a, problemId)
    expect(po?.documents).toHaveLength(2)
    expect(po?.documents.find((d) => d.id === konci.documentId)?.archivedAt).toBeInstanceOf(Date)
    expect(po?.documents.find((d) => d.id === zustava.documentId)?.archivedAt).toBeNull()
  })

  it('vrácení z archivu dokument zase nabídne', async () => {
    const problemId = await zalozProblem(a, 'Návrat z archivu')
    const nahrany = await nahraj(a, { problemId }, 'Dočasně schovaný')

    await withPractice(a.practice.id, (db) =>
      db.templateDocument.update({
        where: { id: nahrany.documentId },
        data: { archivedAt: new Date() },
      }),
    )
    expect(await predvyber(a, problemId)).toHaveLength(0)

    await withPractice(a.practice.id, (db) =>
      db.templateDocument.update({ where: { id: nahrany.documentId }, data: { archivedAt: null } }),
    )
    expect((await predvyber(a, problemId)).map((d) => d.documentId)).toEqual([nahrany.documentId])
  })
})

describe('pořadí dokumentů', () => {
  it('prohození dvou dokumentů změní pořadí v detailu', async () => {
    const problemId = await zalozProblem(a, 'Pořadí')
    await nahraj(a, { problemId }, 'První v pořadí')
    await nahraj(a, { problemId }, 'Druhý v pořadí')

    const pred = await detail(a, problemId)
    expect(pred?.documents.map((d) => d.title)).toEqual(['První v pořadí', 'Druhý v pořadí'])

    await withPractice(a.practice.id, async (db) => {
      const [prvni, druhy] = await db.templateDocument.findMany({
        where: { problemId },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, sortOrder: true },
      })
      if (!prvni || !druhy) throw new Error('Test čekal v problému dva dokumenty.')

      await db.templateDocument.update({
        where: { id: prvni.id },
        data: { sortOrder: druhy.sortOrder },
      })
      await db.templateDocument.update({
        where: { id: druhy.id },
        data: { sortOrder: prvni.sortOrder },
      })
    })

    const po = await detail(a, problemId)
    expect(po?.documents.map((d) => d.title)).toEqual(['Druhý v pořadí', 'První v pořadí'])
    // Ve stejném pořadí se dokumenty i předvybírají do balíčku.
    expect((await predvyber(a, problemId)).map((d) => d.title)).toEqual([
      'Druhý v pořadí',
      'První v pořadí',
    ])
  })
})

describe('oddělení ordinací', () => {
  it('detail problému cizí ordinace se nevrátí', async () => {
    // Znalost id nestačí: row-level security řádek nepropustí, takže
    // findUnique nic nenajde a vrátí se null místo cizích dat.
    expect(await detail(a, problemB)).toBeNull()

    // Ve vlastní ordinaci je přitom tentýž problém vidět normálně.
    expect((await detail(b, problemB))?.name).toBe('Cizí problém')
  })

  it('předvýběr pro problém cizí ordinace je prázdný', async () => {
    await nahraj(b, { problemId: problemB }, 'Cizí leták')

    expect(await predvyber(a, problemB)).toHaveLength(0)
    expect(await predvyber(b, problemB)).toHaveLength(1)
  })
})

describe('předvýběr do balíčku', () => {
  it('dokument bez nahraného souboru se nenabídne', async () => {
    const problemId = await zalozProblem(a, 'Předvýběr')
    const sSouborem = await nahraj(a, { problemId }, 'Hotový leták', 2)
    // Dokument bez verze vzniká, když ho někdo založí a nahrání nedokončí.
    // Předvybrat ho nejde – pacient by dostal položku bez souboru.
    const bezSouboru = await ownerClient.templateDocument.create({
      data: {
        practiceId: a.practice.id,
        problemId,
        title: 'Rozepsaný leták',
        sortOrder: 99,
      },
    })

    const predvybrane = await predvyber(a, problemId)
    expect(predvybrane.map((d) => d.documentId)).toEqual([sSouborem.documentId])
    expect(predvybrane[0]?.versionId).toBe(sSouborem.versionId)
    expect(predvybrane[0]?.pageCount).toBe(2)

    // V knihovně ale vidět je, aby se dal dokončit.
    const rozepsany = (await detail(a, problemId))?.documents.find((d) => d.id === bezSouboru.id)
    expect(rozepsany?.currentVersionId).toBeNull()
    expect(rozepsany?.version).toBeNull()
    expect(rozepsany?.pageCount).toBeNull()
    expect(rozepsany?.versionCount).toBe(0)
  })
})

describe('počet verzí', () => {
  it('po nahrání druhé verze sedí versionCount i údaje o aktuální verzi', async () => {
    const problemId = await zalozProblem(a, 'Verze')
    const prvni = await nahraj(a, { problemId }, 'Režimová opatření', 1)

    const poPrvni = (await detail(a, problemId))?.documents[0]
    expect(poPrvni?.versionCount).toBe(1)
    expect(poPrvni?.version).toBe(1)

    const druha = await nahraj(a, { documentId: prvni.documentId }, 'Režimová opatření', 4)

    const poDruhe = (await detail(a, problemId))?.documents[0]
    expect(poDruhe?.versionCount).toBe(2)
    expect(poDruhe?.version).toBe(2)
    expect(poDruhe?.currentVersionId).toBe(druha.versionId)
    expect(poDruhe?.pageCount).toBe(4)
    expect(poDruhe?.sizeBytes).toBeGreaterThan(0)

    // Nová verze nezakládá druhý dokument.
    expect((await detail(a, problemId))?.documents).toHaveLength(1)
  })
})
