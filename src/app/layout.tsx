import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'

import './globals.css'

/*
 * Písmo se stahuje při sestavení a servíruje z vlastní domény.
 * Načítat ho ze sítě třetí strany nejde: pacientské stránky slibují, že na
 * nich neběží nic cizího, a pravidlo font-src 'self' v CSP by to stejně
 * odmítlo. Podmnožina latin-ext je kvůli české diakritice povinná.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'MedPředání',
  description: 'Předání dokumentů pacientovi bez tisku',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
