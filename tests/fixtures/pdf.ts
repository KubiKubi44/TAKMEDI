import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

/** Vyrobí platné PDF s daným počtem stran. Používají ho testy i seed. */
export async function makePdf(title: string, pages = 1): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)

  // Vestavěné fonty pdf-lib umí jen WinAnsi, takže české znaky by vyhodily
  // výjimku ('WinAnsi cannot encode "č"'). Pro vykreslení textu s diakritikou
  // by bylo potřeba vložit vlastní písmo přes fontkit. Fixtura si vystačí
  // s ASCII, obsah tu stejně nikdo nečte.
  const asciiTitle = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  for (let i = 0; i < pages; i++) {
    const page = document.addPage([595.28, 841.89])
    page.drawText(asciiTitle, { x: 50, y: 780, size: 18, font, color: rgb(0.1, 0.1, 0.1) })
    page.drawText(`Strana ${i + 1} z ${pages}`, { x: 50, y: 750, size: 11, font })
  }

  return Buffer.from(await document.save())
}

/**
 * Platný JPEG 1×1, ověřený proti pdf-lib.
 *
 * Ručně poskládané minimální JPEG, které se dají najít po internetu, embedder
 * v pdf-lib odmítá – tenhle vznikl skutečným převodem přes sips.
 */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+T6KKK/qw/ms/9k=',
  'base64',
)

/** Platný PNG 1×1. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSFgAAAHEASFiX4r9AAAAAElFTkSuQmCC',
  'base64',
)

/**
 * Vrátí tentýž obsah jako Buffer s NENULOVÝM posunem v paměti, jaký vzniká
 * při čtení ze sítě nebo z disku. Odhaluje chyby knihoven, které posun ignorují.
 */
export function asPooledBuffer(data: Buffer): Buffer {
  const pool = Buffer.alloc(data.byteLength + 1000)
  data.copy(pool, 500)
  return pool.subarray(500, 500 + data.byteLength)
}
