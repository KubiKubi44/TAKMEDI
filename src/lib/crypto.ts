import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'

import { env } from './env'

/**
 * Kryptografie aplikace.
 *
 * Tři různé úlohy, tři různé nástroje – volba se řídí velikostí prostoru
 * tajemství, ne zvykem:
 *
 *  - Dlouhá náhodná tajemství (pacientský token, session) mají 256 bitů
 *    entropie. Prostý SHA-256 je u nich bezpečný a navíc indexovatelný,
 *    takže hledání podle hashe je rychlé.
 *  - Krátká tajemství (čtyřmístný kód předání, šestimístný PIN, datum
 *    narození) mají prostor v řádu tisíců. Pomalý hash je tu k ničemu –
 *    útočník s databází je projde tak jako tak. Pomáhá až HMAC s pepperem
 *    uloženým mimo databázi: únik samotné databáze pak kód neprozradí.
 *  - Hesla uživatelů jsou v src/lib/password.ts přes argon2id.
 */

const MASTER_KEY = Buffer.from(env.FILE_MASTER_KEY, 'base64')
const PEPPER = Buffer.from(env.SECRET_PEPPER, 'base64')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

/** Verze hlavního klíče – umožní jeho výměnu bez přešifrování všeho najednou. */
export const CURRENT_KEY_VERSION = 1

/**
 * Tvar, ve kterém Prisma přijímá sloupce typu Bytes.
 *
 * Buffer.concat vrací Buffer<ArrayBufferLike>, což TypeScript na Uint8Array<ArrayBuffer>
 * nepustí – ArrayBufferLike zahrnuje i SharedArrayBuffer. Převod je kopie, ale
 * jde o desítky bajtů (klíč, inicializační vektor, autentizační značka).
 */
export type DbBytes = Uint8Array<ArrayBuffer>

function asDbBytes(buf: Buffer): DbBytes {
  return new Uint8Array(buf) as DbBytes
}

// ---------------------------------------------------------------------------
// Náhodná tajemství
// ---------------------------------------------------------------------------

/** Pacientský token do adresy /d/<token>. 256 bitů entropie. */
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Token do session cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Tajemství zapsané na NFC čip, součást adresy /o/<slug>/<tajemstvi>. */
export function generateTagSecret(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Čtyřmístný kód předání. randomInt je rovnoměrný – modulo z randomBytes by
 * některé kódy zvýhodnilo.
 */
export function generateHandoffCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0')
}

/** Šestimístný PIN pro ověření u odkazu poslaného e-mailem. */
export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** Záložní kód pro případ ztráty telefonu s TOTP. */
export function generateRecoveryCode(): string {
  // Bez znaků, které se pletou při přepisu z papíru (0/O, 1/I/l).
  const abeceda = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < 10; i++) out += abeceda[randomInt(0, abeceda.length)]
  return `${out.slice(0, 5)}-${out.slice(5)}`
}

// ---------------------------------------------------------------------------
// Hashování
// ---------------------------------------------------------------------------

/** Pro dlouhá náhodná tajemství. Výsledek je hex, tedy indexovatelný. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Pro krátká tajemství. Pepper je mimo databázi. */
export function hmacSecret(value: string): string {
  return createHmac('sha256', PEPPER).update(value, 'utf8').digest('hex')
}

/** Porovnání hexových hashů odolné vůči měření času. */
export function secretMatches(candidate: string, storedHmac: string): boolean {
  const a = Buffer.from(hmacSecret(candidate), 'hex')
  const b = Buffer.from(storedHmac, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Porovnání dvou hashů tokenu odolné vůči měření času. */
export function tokenHashMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Šifrování polí v databázi
// ---------------------------------------------------------------------------

/**
 * Zašifruje krátkou hodnotu (jméno pacienta, poznámka, e-mail příjemce).
 * Výstup má tvar iv ‖ tag ‖ šifrovaný text a ukládá se do sloupce typu Bytes.
 *
 * Následek, se kterým se počítá: takto uložené hodnoty nejdou prohledávat.
 * V historii se proto hledá podle data, problému, uživatele a kanálu.
 */
export function encryptField(plaintext: string): DbBytes {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return asDbBytes(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))
}

export function decryptField(stored: Buffer | Uint8Array): string {
  const buf = Buffer.from(stored)
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Zkratky pro nepovinná pole. */
export function encryptOptional(value: string | null | undefined): DbBytes | null {
  if (!value) return null
  return encryptField(value)
}

export function decryptOptional(stored: Buffer | Uint8Array | null | undefined): string | null {
  if (!stored) return null
  return decryptField(stored)
}

// ---------------------------------------------------------------------------
// Obálkové šifrování souborů
// ---------------------------------------------------------------------------

export type EncryptedFile = {
  /** Šifrovaný obsah – tohle jediné se posílá do úložiště. */
  ciphertext: Buffer
  /** Klíč souboru zabalený hlavním klíčem, ukládá se k záznamu v databázi. */
  dekWrapped: DbBytes
  contentIv: DbBytes
  contentTag: DbBytes
  keyVersion: number
}

/**
 * Každý soubor má vlastní klíč, ten se zabalí hlavním klíčem a uloží k záznamu.
 * Úložiště tak nikdy nevidí čitelný obsah, i kdyby selhalo šifrování na jeho
 * straně.
 *
 * Cesta v úložišti vstupuje do šifrování jako doplňková autentizovaná data.
 * Prohození dvou souborů mezi záznamy proto neprojde – dešifrování selže.
 */
export function encryptFile(content: Buffer, storageKey: string): EncryptedFile {
  const dek = randomBytes(32)
  const contentIv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, dek, contentIv)
  cipher.setAAD(Buffer.from(storageKey, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()])
  const contentTag = cipher.getAuthTag()

  const wrapIv = randomBytes(IV_LENGTH)
  const wrapper = createCipheriv(ALGORITHM, MASTER_KEY, wrapIv)
  const wrapped = Buffer.concat([wrapper.update(dek), wrapper.final()])
  const dekWrapped = Buffer.concat([wrapIv, wrapper.getAuthTag(), wrapped])

  return {
    ciphertext,
    dekWrapped: asDbBytes(dekWrapped),
    contentIv: asDbBytes(contentIv),
    contentTag: asDbBytes(contentTag),
    keyVersion: CURRENT_KEY_VERSION,
  }
}

/**
 * Dešifrování proběhne celé v paměti a teprve ověřený obsah se pošle dál.
 * Streamovat a ověřit autentizační značku až na konci by znamenalo, že
 * prohlížeč už část poškozených dat dostal. Soubory mají nejvýš jednotky MB,
 * takže je to levné.
 */
export function decryptFile(params: {
  ciphertext: Buffer | Uint8Array
  dekWrapped: Buffer | Uint8Array
  contentIv: Buffer | Uint8Array
  contentTag: Buffer | Uint8Array
  storageKey: string
}): Buffer {
  const wrappedBuf = Buffer.from(params.dekWrapped)
  const wrapIv = wrappedBuf.subarray(0, IV_LENGTH)
  const wrapTag = wrappedBuf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const wrapped = wrappedBuf.subarray(IV_LENGTH + TAG_LENGTH)

  const unwrapper = createDecipheriv(ALGORITHM, MASTER_KEY, wrapIv)
  unwrapper.setAuthTag(wrapTag)
  const dek = Buffer.concat([unwrapper.update(wrapped), unwrapper.final()])

  const decipher = createDecipheriv(ALGORITHM, dek, Buffer.from(params.contentIv))
  decipher.setAAD(Buffer.from(params.storageKey, 'utf8'))
  decipher.setAuthTag(Buffer.from(params.contentTag))
  return Buffer.concat([decipher.update(Buffer.from(params.ciphertext)), decipher.final()])
}

/** Otisk původního nešifrovaného obsahu – kontrola integrity a deduplikace. */
export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
