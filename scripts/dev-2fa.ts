import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import * as OTPAuth from 'otpauth'

import { PrismaClient } from '../src/generated/prisma/client'

/**
 * Vývojový pomocník pro dvoufázové přihlášení.
 *
 * Vypíše aktuální kód, který by jinak ukázala aplikace v telefonu, aby se dal
 * projít přihlašovací tok bez telefonu po ruce. Nebo druhý faktor zruší, aby
 * se dalo jeho nastavení projít znovu.
 *
 * NENÍ TO ZADNÍ VRÁTKA DO PRODUKCE: skript čte tajemství přímo z databáze,
 * takže ho smí použít jen ten, kdo do ní už stejně vidí. V produkčním
 * prostředí se odmítne spustit.
 *
 *   npm run dev:2fa -- lekar@example.cz          vypíše kód
 *   npm run dev:2fa -- lekar@example.cz --reset  zruší druhý faktor
 */

if (process.env.NODE_ENV === 'production') {
  console.error('Tenhle skript je jen pro vývoj a v produkci se nespouští.')
  process.exit(1)
}

const email = process.argv[2]
const reset = process.argv.includes('--reset')

if (!email) {
  console.error('Použití: npm run dev:2fa -- <e-mail> [--reset]')
  process.exit(1)
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const user = await prisma.user.findUnique({
  where: { email },
  select: { id: true, email: true, name: true, totpSecretEnc: true, totpConfirmedAt: true },
})

if (!user) {
  console.error(`Uživatel ${email} v databázi není.`)
  process.exit(1)
}

if (reset) {
  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecretEnc: null, totpConfirmedAt: null, totpLastCounter: null },
  })
  console.log(`Druhý faktor pro ${email} zrušen. Při dalším přihlášení projdeš jeho nastavením znovu.`)
  await prisma.$disconnect()
  process.exit(0)
}

if (!user.totpSecretEnc) {
  console.error(
    `Pro ${email} zatím žádné tajemství neexistuje.\n\n` +
      'Přihlas se heslem a nech si zobrazit stránku s QR kódem – tím tajemství vznikne.\n' +
      'Pak spusť tenhle příkaz znovu a kód sem vypíšu.',
  )
  process.exit(1)
}

// Dešifrování se dělá tady a ne přes src/lib/crypto.ts, protože ten modul
// importuje 'server-only' a mimo Next.js se načíst nedá.
const { createDecipheriv } = await import('node:crypto')
const masterKey = Buffer.from(process.env.FILE_MASTER_KEY!, 'base64')
const stored = Buffer.from(user.totpSecretEnc)
const decipher = createDecipheriv('aes-256-gcm', masterKey, stored.subarray(0, 12))
decipher.setAuthTag(stored.subarray(12, 28))
const secretBase32 = Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString('utf8')

const totp = new OTPAuth.TOTP({
  issuer: 'MedPředání',
  label: user.email,
  secret: OTPAuth.Secret.fromBase32(secretBase32),
})

const zbyva = Math.ceil(totp.remaining() / 1000)

console.log()
console.log(`  Kód pro ${user.email}:  ${totp.generate()}`)
console.log(`  Platí ještě ${zbyva} s, pak se změní.`)
console.log(`  Druhý faktor: ${user.totpConfirmedAt ? 'už je aktivovaný' : 'ještě není aktivovaný'}`)
console.log()

await prisma.$disconnect()
