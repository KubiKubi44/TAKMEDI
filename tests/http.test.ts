import { describe, expect, it } from 'vitest'

import { contentDisposition, pdfResponse } from '@/lib/http'

describe('hlavička Content-Disposition', () => {
  it('český název projde jako ASCII náhrada i jako RFC 5987', () => {
    const value = contentDisposition('Příbalový leták.pdf')

    expect(value).toContain('filename="Pribalovy letak.pdf"')
    expect(value).toContain("filename*=UTF-8''P%C5%99%C3%ADbalov%C3%BD%20let%C3%A1k.pdf")
  })

  it('název se vejde do hlavičky, aniž by Headers vyhodily výjimku', () => {
    // Headers přijímají jen ByteString. Diakritika bez převodu shodí handler.
    const headers = new Headers()
    expect(() =>
      headers.set('Content-Disposition', contentDisposition('Cvičení po operaci kolene.pdf')),
    ).not.toThrow()
  })

  it('uvozovky a zpětná lomítka se z náhrady odstraní', () => {
    // Jinak by se dal název ukončit uvozovkou a připsat další parametry.
    const value = contentDisposition('zla"vec\\.pdf')
    expect(value).toContain('filename="zlavec.pdf"')
  })

  it('název složený jen z diakritiky nezůstane prázdný', () => {
    expect(contentDisposition('ěščřž')).toContain('filename="escrz"')
  })

  it('název bez jediného použitelného znaku dostane náhradu', () => {
    expect(contentDisposition('日本語')).toContain('filename="dokument.pdf"')
  })
})

describe('odpověď s PDF', () => {
  it('Content-Length odpovídá skutečné délce těla', async () => {
    // Menší hodnota by odpověď mlčky usekla a klient by dostal poškozené PDF
    // se stavem 200. Větší by nechala spojení viset.
    const bytes = Buffer.from('%PDF-1.7 obsah dokumentu s diakritikou: ěščř')
    const response = pdfResponse({ bytes, filename: 'zpráva.pdf' })

    const doruceno = Buffer.from(await response.arrayBuffer())

    expect(response.headers.get('Content-Length')).toBe(String(doruceno.byteLength))
    expect(doruceno.equals(bytes)).toBe(true)
  })

  it('zdravotní dokumentace se nikde neukládá do mezipaměti a neindexuje', () => {
    const response = pdfResponse({ bytes: Buffer.from('%PDF'), filename: 'a.pdf' })

    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('výchozí je stažení, náhled se musí vyžádat', () => {
    expect(pdfResponse({ bytes: Buffer.from('%PDF'), filename: 'a.pdf' }).headers.get('Content-Disposition')).toContain('attachment')
    expect(
      pdfResponse({ bytes: Buffer.from('%PDF'), filename: 'a.pdf', inline: true }).headers.get('Content-Disposition'),
    ).toContain('inline')
  })
})
