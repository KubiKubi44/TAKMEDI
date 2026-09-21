import type { NextConfig } from 'next'

/**
 * Bezpečnostní hlavičky platí pro celou aplikaci.
 *
 * Content-Security-Policy se nastavuje v src/middleware.ts, protože potřebuje
 * nonce generovaný pro každý požadavek zvlášť. Zbytek je statický a patří sem.
 */
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Zabrání tomu, aby se tajemství z adresy NFC čipu dostalo do hlavičky
  // Referer při odchodu na jinou stránku.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    /**
     * Zpřístupní forbidden() a stránku forbidden.tsx.
     *
     * Bez toho by odepřený přístup končil vyhozenou výjimkou, tedy stavem 500
     * a chybovou hranicí, která je klientská – text by se vykreslil až v
     * prohlížeči a stavový kód by lhal. S tímhle vrací aplikace poctivou 403
     * vykreslenou na serveru.
     *
     * Je to experimentální volba, ale používá ji jediné místo (requireRole
     * v src/lib/auth.ts), takže případná změna API je oprava na jeden řádek.
     */
    authInterrupts: true,
  },

  // Balíčky, které mají zůstat mimo bundler a běžet nativně na serveru.
  // pdf-lib musí zůstat mimo bundle: zpracování PDF běží v odděleném vlákně,
  // jehož zdroj je řetězec, a to si knihovnu načítá přes require za běhu.
  serverExternalPackages: ['@node-rs/argon2', '@prisma/adapter-pg', 'pdf-lib'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Pacientské stránky se nesmí indexovat ani ukládat do mezipaměti.
        source: '/d/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
      {
        source: '/o/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ]
  },
}

export default nextConfig
