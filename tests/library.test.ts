import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, withPractice } from '@/lib/db'
import { listProblems, searchProblems } from '@/lib/library'
import { createPractice, ownerClient, removePractice } from './helpers'

/**
 * Hledání v knihovně.
 *
 * Testy se dívají na dvě různé věci: jestli hledání najde, co má, a jestli
 * syrové SQL neobchází oddělení ordinací. To druhé je důležitější.
 */

let a: Awaited<ReturnType<typeof createPractice>>
let b: Awaited<ReturnType<typeof createPractice>>

beforeAll(async () => {
  a = await createPractice('Knihovna A')
  b = await createPractice('Knihovna B')

  await ownerClient.problem.createMany({
    data: [
      { practiceId: a.practice.id, name: 'Po operaci kolene', icd10: 'Z96.6', sortOrder: 1 },
      { practiceId: a.practice.id, name: 'Hypertenze – režimová opatření', icd10: 'I10', sortOrder: 2 },
      { practiceId: a.practice.id, name: 'Akutní bolesti zad', icd10: 'M54.5', sortOrder: 3 },
      { practiceId: a.practice.id, name: 'Archivovaný problém', archivedAt: new Date(), sortOrder: 4 },
      // Ordinace B má schválně problém s podobným názvem i stejným kódem.
      { practiceId: b.practice.id, name: 'Po operaci kolene u dětí', icd10: 'Z96.6', sortOrder: 1 },
    ],
  })
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('oddělení ordinací', () => {
  it('syrové SQL bez filtru na ordinaci vidí jen vlastní problémy', async () => {
    // V dotazu v src/lib/library.ts ZÁMĚRNĚ není podmínka na practice_id.
    // Kdyby row-level security na syrové dotazy nedosáhla, tenhle test padne.
    const nalezene = await withPractice(a.practice.id, (db) => listProblems(db))

    expect(nalezene).toHaveLength(3)
    expect(nalezene.map((p) => p.name)).not.toContain('Po operaci kolene u dětí')
  })

  it('hledání podle kódu nenajde stejný kód v cizí ordinaci', async () => {
    const zA = await withPractice(a.practice.id, (db) => searchProblems(db, 'Z96.6'))
    const zB = await withPractice(b.practice.id, (db) => searchProblems(db, 'Z96.6'))

    expect(zA.map((p) => p.name)).toEqual(['Po operaci kolene'])
    expect(zB.map((p) => p.name)).toEqual(['Po operaci kolene u dětí'])
  })
})

describe('hledání podle názvu', () => {
  it('najde podle části slova uprostřed názvu', async () => {
    // Tohle je ten případ, kvůli kterému se používá word_similarity:
    // podobnost celých řetězců je jen 0,25, tedy pod výchozím prahem.
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'koleno'))
    expect(nalezene.map((p) => p.name)).toContain('Po operaci kolene')
  })

  it('najde i při překlepu', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'hypertense'))
    expect(nalezene.map((p) => p.name)).toContain('Hypertenze – režimová opatření')
  })

  it('nerozlišuje velikost písmen ani diakritiku v kódu', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'z96.6'))
    expect(nalezene[0]?.name).toBe('Po operaci kolene')
  })

  it('přesná shoda kódu je první, i když se název podobá jinému', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'I10'))
    expect(nalezene[0]?.exactCode).toBe(true)
    expect(nalezene[0]?.name).toBe('Hypertenze – režimová opatření')
  })

  it('archivované problémy se nenabízejí', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'Archivovaný'))
    expect(nalezene).toHaveLength(0)
  })

  it('nesmysl nenajde nic', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, 'xyzqwerty'))
    expect(nalezene).toHaveLength(0)
  })
})

describe('odolnost vstupu', () => {
  it('zástupné znaky se berou doslova, ne jako vzor', async () => {
    // Bez escapování by '%' našlo úplně všechno.
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, '%'))
    expect(nalezene).toHaveLength(0)
  })

  it('podtržítko taky nezastupuje libovolný znak', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, '_'))
    expect(nalezene).toHaveLength(0)
  })

  it('apostrof a středník dotaz nerozbijí', async () => {
    const nalezene = await withPractice(a.practice.id, (db) =>
      searchProblems(db, "'; DROP TABLE problem; --"),
    )
    expect(nalezene).toHaveLength(0)

    // A tabulka pořád existuje.
    const porad = await withPractice(a.practice.id, (db) => listProblems(db))
    expect(porad.length).toBeGreaterThan(0)
  })

  it('prázdné hledání vrátí výchozí seznam seřazený podle pořadí', async () => {
    const nalezene = await withPractice(a.practice.id, (db) => searchProblems(db, '   '))
    expect(nalezene.map((p) => p.name)).toEqual([
      'Po operaci kolene',
      'Hypertenze – režimová opatření',
      'Akutní bolesti zad',
    ])
  })
})
