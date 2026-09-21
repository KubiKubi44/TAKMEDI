import 'server-only'

/**
 * Odesílání souborů z route handlerů.
 *
 * Dvě věci se tu dělají ručně, protože obě mlčky rozbijí stažený soubor:
 *
 *  1. Content-Length musí sedět PŘESNĚ. Next i Node berou hlavičku doslova:
 *     menší hodnota než skutečná délka useká odpověď a klient dostane
 *     poškozené PDF se stavem 200, větší hodnota nechá spojení viset do
 *     timeoutu. U dešifrovaného obsahu se délka liší od té zašifrované,
 *     takže se počítá až z hotových bajtů.
 *
 *  2. Název souboru s diakritikou se do hlavičky nedá napsat přímo. Headers
 *     přijímají jen ByteString (0–255), takže „Příbalový leták.pdf" vyhodí
 *     TypeError a celý handler spadne. Posílá se proto ASCII náhrada
 *     a vedle ní filename* podle RFC 5987.
 */

/** Ořeže název na to, co bezpečně projde hlavičkou i souborovým systémem. */
function asciiFallback(filename: string): string {
  const bezDiakritiky = filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .trim()

  return bezDiakritiky || 'dokument.pdf'
}

export function contentDisposition(filename: string, inline = false): string {
  const disposition = inline ? 'inline' : 'attachment'
  const ascii = asciiFallback(filename)
  const utf8 = encodeURIComponent(filename)

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

export function pdfResponse(params: {
  bytes: Buffer
  filename: string
  /** true = zobrazit v prohlížeči (náhled, tisk), false = stáhnout. */
  inline?: boolean
}): Response {
  // Uint8Array, ne Buffer: Response očekává BodyInit a Buffer se v některých
  // běhových prostředích chová jinak.
  const body = new Uint8Array(params.bytes)

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': contentDisposition(params.filename, params.inline),
      // Zdravotní dokumentace nepatří do žádné mezipaměti po cestě.
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  })
}

/** Odpověď bez podrobností – ven se nesmí dostat, proč přesně to selhalo. */
export function notFoundResponse(): Response {
  return new Response('Nenalezeno', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
