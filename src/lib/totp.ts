import 'server-only'

import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'

/**
 * Druhý faktor přihlášení (TOTP).
 *
 * Tajemství se v databázi ukládá zašifrované aplikačním klíčem (sloupec
 * User.totpSecretEnc), takže únik samotné databáze druhý faktor neprolomí.
 */

const ISSUER = 'MedPředání'

/** 20 bajtů = 160 bitů, doporučená délka podle RFC 4226. */
const SECRET_SIZE = 20

/**
 * Tolerance ±1 okno, tedy ±30 sekund. Pokrývá běžný rozjezd hodin v telefonu,
 * aniž by se zbytečně rozšiřovalo okno pro útočníka.
 */
const WINDOW = 1

function buildTotp(secretBase32: string, accountLabel: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountLabel,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
    // algoritmus, počet číslic a perioda zůstávají na výchozích hodnotách
    // (SHA1 / 6 / 30 s) – tak to očekávají všechny běžné autentizátory.
  })
}

export type TotpEnrollment = {
  /** Base32 pro uložení do databáze (zašifrovaně). */
  secretBase32: string
  /** Adresa otpauth:// pro ruční zadání do aplikace. */
  uri: string
  /** QR kód jako data URL – vykreslí se přímo do <img src>. */
  qrDataUrl: string
}

/**
 * Vykreslí adresu a QR kód pro UŽ EXISTUJÍCÍ tajemství.
 *
 * Používá se při opakovaném zobrazení obrazovky nastavení – tajemství musí
 * zůstat stejné, jinak by uživatel, který stránku obnoví, měl v telefonu
 * uloženou položku, se kterou se už nikdy nepřihlásí.
 */
export async function renderTotpEnrollment(
  secretBase32: string,
  accountLabel: string,
): Promise<{ uri: string; qrDataUrl: string }> {
  const totp = buildTotp(secretBase32, accountLabel)
  const uri = totp.toString()

  const qrDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  })

  return { uri, qrDataUrl }
}

/** Připraví nové tajemství pro uživatele, který si teprve nastavuje 2FA. */
export async function createTotpEnrollment(accountLabel: string): Promise<TotpEnrollment> {
  const secret = new OTPAuth.Secret({ size: SECRET_SIZE })
  const { uri, qrDataUrl } = await renderTotpEnrollment(secret.base32, accountLabel)
  return { secretBase32: secret.base32, uri, qrDataUrl }
}

export type TotpResult =
  | { ok: true; counter: bigint }
  | { ok: false; reason: 'invalid' | 'replayed' }

/**
 * Ověří zadaný kód.
 *
 * Kromě platnosti hlídá i opakované použití: šestimístný kód platí celých
 * 30 sekund, takže kdo ho zahlédne přes rameno nebo odchytí, mohl by se s ním
 * přihlásit podruhé. Číslo použitého okna se proto ukládá k uživateli a stejné
 * nebo starší okno se příště odmítne.
 *
 * Porovnání samotného kódu dělá knihovna časově stabilně.
 */
export function verifyTotp(params: {
  secretBase32: string
  accountLabel: string
  token: string
  lastCounter: bigint | null
}): TotpResult {
  const totp = buildTotp(params.secretBase32, params.accountLabel)

  const delta = totp.validate({ token: params.token.trim(), window: WINDOW })
  if (delta === null) return { ok: false, reason: 'invalid' }

  const usedCounter = BigInt(totp.counter() + delta)
  if (params.lastCounter !== null && usedCounter <= params.lastCounter) {
    return { ok: false, reason: 'replayed' }
  }

  return { ok: true, counter: usedCounter }
}
