import { NextResponse, type NextRequest } from 'next/server'

/**
 * Content-Security-Policy s nonce.
 *
 * Soubor se od Next.js 16 jmenuje proxy.ts – dřívější konvence middleware.ts
 * je zastaralá.
 *
 * Nonce se musí lišit požadavek od požadavku, proto se nedá nastavit staticky
 * v next.config.ts jako ostatní hlavičky. Díky 'strict-dynamic' stačí označit
 * jen vstupní skripty Next.js a nemusí se udržovat seznam povolených domén.
 *
 * Na pacientských stránkách /d/* tím zároveň držíme slib, že tam neběží žádný
 * skript třetí strany ani analytika.
 */
export default function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  const csp = [
    "default-src 'self'",
    // Vývojový režim Next.js potřebuje eval kvůli hot reloadu.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    // Tisk otevírá sloučené PDF ve skrytém rámu ze stejného původu.
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  // Next si nonce pro své vlastní <script> tagy bere z x-nonce – ověřeno
  // na vykreslené stránce. Hlavička se přesto nastavuje i sem, protože to je
  // postup z dokumentace a stojí jednu řádku: kdyby se chování verzí změnilo,
  // aplikace se kvůli 'strict-dynamic' rozbije naráz a bez varování.
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    // Vynechané jsou statické soubory, obrázky a celé /api.
    //
    // /api je tu z bezpečnostního důvodu, ne z pohodlnosti: když proxy cestu
    // chytí, Next tělo požadavku naklonuje a nabufferuje s výchozím limitem
    // 10 MB (experimental.proxyClientMaxBodySize) a při překročení ho MLČKY
    // usekne – nahrané PDF by dorazilo poškozené bez jediné chybové hlášky.
    // Hlavičku CSP navíc potřebují stránky, ne odpovědi se soubory a JSON;
    // ostatní bezpečnostní hlavičky se nastavují v next.config.ts a platí všude.
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
