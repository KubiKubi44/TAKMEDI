import { describe, expect, it } from 'vitest'

import { PdfError, imageToPdf, inspectPdf, looksLikePdf, mergePdfs } from '@/lib/pdf'
import { TINY_JPEG, TINY_PNG, asPooledBuffer, makePdf } from './fixtures/pdf'

/**
 * Zpracování PDF.
 *
 * Soubory chodí od lidí a jejich zařízení, takže testy se soustředí na to,
 * co přijde špatně – a jestli z toho vypadne srozumitelný český důvod.
 */

async function problem(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return 'nic nespadlo'
  } catch (error) {
    return error instanceof PdfError ? error.problem : `jiná chyba: ${String(error)}`
  }
}

describe('ověření nahraného PDF', () => {
  it('platné PDF projde a spočítá strany', async () => {
    expect(await inspectPdf(await makePdf('Poučení', 3))).toEqual({ pageCount: 3 })
  })

  it('prázdný soubor', async () => {
    expect(await problem(() => inspectPdf(Buffer.alloc(0)))).toBe('prazdny')
  })

  it('soubor, který není PDF', async () => {
    expect(await problem(() => inspectPdf(Buffer.from('tohle je textový soubor')))).toBe('neni-pdf')
  })

  it('obrázek přejmenovaný na .pdf', async () => {
    expect(await problem(() => inspectPdf(TINY_JPEG))).toBe('neni-pdf')
  })

  it('useknuté PDF', async () => {
    const platne = await makePdf('Poučení', 3)
    expect(await problem(() => inspectPdf(platne.subarray(0, Math.floor(platne.length / 2))))).toBe(
      'poskozeny',
    )
  })

  it('soubor nad povolenou velikost', async () => {
    // Kontrola velikosti musí proběhnout dřív, než se obsah vůbec začne parsovat.
    expect(await problem(() => inspectPdf(Buffer.alloc(21 * 1024 * 1024)))).toBe('prilis-velky')
  })

  it('každý důvod má českou hlášku, která říká, co dělat', async () => {
    const chyba = new PdfError('chraneny-heslem')
    expect(chyba.message).toContain('heslem')
    expect(chyba.message).toContain('bez hesla')
  })

  it('samotná hlavička bez obsahu je poškozený soubor, ne platné PDF', async () => {
    // pdf-lib takový soubor NAČTE bez chyby a spadne až getPageCount().
    // Kdyby se na úspěšné načtení spoléhalo, prošel by dovnitř.
    expect(await problem(() => inspectPdf(Buffer.from('%PDF-1.7\n')))).toBe('poskozeny')
  })

  it('smetí za hlavičkou PDF neblokuje hlavní smyčku', async () => {
    // Obnovovací skener parseru se na takovém souboru zvrhne do kvadratické
    // složitosti a jeho práce běží v hlavní smyčce. Jediný nahraný soubor by
    // tak zmrazil celou aplikaci VŠEM uživatelům, ne jen tomu, kdo ho poslal.
    //
    // Test proto neměří, jak dlouho zpracování trvá, ale jestli mezitím
    // aplikace vůbec žije: současně běží tikot, který se při zablokované
    // smyčce nespustí ani jednou.
    const utok = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('x'.repeat(1024 * 1024))])

    let tiku = 0
    const tikot = setInterval(() => { tiku += 1 }, 20)

    const vysledek = await problem(() => inspectPdf(utok))
    clearInterval(tikot)

    expect(['trva-prilis-dlouho', 'poskozeny']).toContain(vysledek)
    expect(tiku).toBeGreaterThan(5)
  }, 30_000)
})

describe('rozpoznání podle obsahu', () => {
  it('pozná PDF podle hlavičky, ne podle názvu', async () => {
    expect(looksLikePdf(await makePdf('x'))).toBe(true)
    expect(looksLikePdf(TINY_JPEG)).toBe(false)
    expect(looksLikePdf(Buffer.from('%PDF'))).toBe(false)
  })
})

describe('slučování', () => {
  it('spojí dokumenty v zadaném pořadí a sečte strany', async () => {
    const merged = await mergePdfs([
      await makePdf('První', 2),
      await makePdf('Druhý', 3),
      await makePdf('Třetí', 1),
    ])

    expect(await inspectPdf(merged)).toEqual({ pageCount: 6 })
  })

  it('jediný dokument projde beze změny počtu stran', async () => {
    const merged = await mergePdfs([await makePdf('Sám', 4)])
    expect(await inspectPdf(merged)).toEqual({ pageCount: 4 })
  })

  it('prázdný seznam je chyba, ne prázdné PDF', async () => {
    expect(await problem(() => mergePdfs([]))).toBe('bez-stranek')
  })

  it('jeden vadný dokument shodí slučování se srozumitelným důvodem', async () => {
    const dobry = await makePdf('Dobrý')
    expect(await problem(() => mergePdfs([dobry, Buffer.from('rozbité')]))).toBe('neni-pdf')
  })

  it('sloučený dokument nenese JavaScript na úrovni dokumentu', async () => {
    // Slučování není sanitizace: copyPages sice zahodí /Names a /OpenAction,
    // ale spoléhat se na to nelze, protože jde o soubory od cizích lidí.
    const merged = await mergePdfs([await makePdf('A', 1), await makePdf('B', 1)])
    const text = merged.toString('latin1')

    expect(text).not.toContain('/JavaScript')
    expect(text).not.toContain('/OpenAction')
  })
})

describe('fotka nebo sken', () => {
  it('z JPEG udělá jednostránkové PDF', async () => {
    const pdf = await imageToPdf(TINY_JPEG, 'image/jpeg')
    expect(looksLikePdf(pdf)).toBe(true)
    expect(await inspectPdf(pdf)).toEqual({ pageCount: 1 })
  })

  it('HEIC z iPhonu dostane srozumitelnou hlášku, ne pád', async () => {
    const problem_ = await problem(() => imageToPdf(TINY_JPEG, 'image/heic'))
    expect(problem_).toBe('nepodporovany-obrazek')

    expect(new PdfError('nepodporovany-obrazek').message).toContain('JPEG')
  })

  it('data, která nejsou obrázek, neprojdou ani při správném typu', async () => {
    expect(await problem(() => imageToPdf(Buffer.from('nejsem obrazek'), 'image/jpeg'))).toBe(
      'nepodporovany-obrazek',
    )
  })

  it('z PNG udělá jednostránkové PDF', async () => {
    expect(await inspectPdf(await imageToPdf(TINY_PNG, 'image/png'))).toEqual({ pageCount: 1 })
  })

  it('fotka z nenulovým posunem v paměti projde stejně jako běžná', async () => {
    // Data načtená ze sítě nebo z disku bývají výřezem ze sdíleného poolu
    // a mají nenulový byteOffset. Embedder JPEG v pdf-lib ho ignoruje
    // (new DataView(imageData.buffer)) a nad platnou fotkou pak hlásí
    // „SOI not found in JPEG". Bez normalizace v src/lib/pdf.ts tenhle test padá.
    const posunuty = asPooledBuffer(TINY_JPEG)
    expect(posunuty.byteOffset).toBeGreaterThan(0)

    expect(await inspectPdf(await imageToPdf(posunuty, 'image/jpeg'))).toEqual({ pageCount: 1 })
  })

  it('PDF s nenulovým posunem se načte i sloučí', async () => {
    const posunute = asPooledBuffer(await makePdf('Zprava', 2))
    expect(await inspectPdf(posunute)).toEqual({ pageCount: 2 })
    expect(await inspectPdf(await mergePdfs([posunute, posunute]))).toEqual({ pageCount: 4 })
  })
})
