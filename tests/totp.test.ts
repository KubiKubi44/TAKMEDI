import * as OTPAuth from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, withPractice } from '@/lib/db'
import { encryptField } from '@/lib/crypto'
import { createTotpEnrollment, renderTotpEnrollment, verifyTotp } from '@/lib/totp'
import { createPractice, ownerClient, removePractice } from './helpers'

/** Vyrobí platný kód pro dané tajemství, jako by ho ukázal telefon. */
function currentCode(secretBase32: string, label: string, offset = 0): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'MedPředání',
    label,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  })
  return totp.generate({ timestamp: Date.now() + offset * 30_000 })
}

let a: Awaited<ReturnType<typeof createPractice>>

beforeAll(async () => {
  a = await createPractice('TOTP')
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('ověření kódu', () => {
  const label = 'lekar@example.cz'

  it('platný kód projde', async () => {
    const { secretBase32 } = await createTotpEnrollment(label)
    const result = verifyTotp({
      secretBase32,
      accountLabel: label,
      token: currentCode(secretBase32, label),
      lastCounter: null,
    })
    expect(result.ok).toBe(true)
  })

  it('cizí kód neprojde', async () => {
    const { secretBase32 } = await createTotpEnrollment(label)
    const jine = await createTotpEnrollment(label)

    const result = verifyTotp({
      secretBase32,
      accountLabel: label,
      token: currentCode(jine.secretBase32, label),
      lastCounter: null,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('stejný kód nejde použít dvakrát', async () => {
    // Šestimístný kód platí celých 30 sekund. Kdo ho zahlédne přes rameno nebo
    // odchytí, mohl by se s ním přihlásit podruhé – proto se číslo použitého
    // okna ukládá a stejné nebo starší se odmítne.
    const { secretBase32 } = await createTotpEnrollment(label)
    const token = currentCode(secretBase32, label)

    const prvni = verifyTotp({ secretBase32, accountLabel: label, token, lastCounter: null })
    expect(prvni.ok).toBe(true)

    const druhy = verifyTotp({
      secretBase32,
      accountLabel: label,
      token,
      lastCounter: prvni.ok ? prvni.counter : null,
    })
    expect(druhy).toEqual({ ok: false, reason: 'replayed' })
  })

  it('kód z příštího okna projde i po použití toho současného', async () => {
    const { secretBase32 } = await createTotpEnrollment(label)

    const soucasny = verifyTotp({
      secretBase32,
      accountLabel: label,
      token: currentCode(secretBase32, label),
      lastCounter: null,
    })
    expect(soucasny.ok).toBe(true)

    const pristi = verifyTotp({
      secretBase32,
      accountLabel: label,
      token: currentCode(secretBase32, label, 1),
      lastCounter: soucasny.ok ? soucasny.counter : null,
    })
    expect(pristi.ok).toBe(true)
  })
})

describe('nastavení druhého faktoru', () => {
  it('stejné tajemství dá pokaždé stejný QR kód', async () => {
    // Obnovení stránky nesmí vyrobit nové tajemství – uživatel by měl
    // v telefonu uloženou položku, se kterou se už nikdy nepřihlásí.
    const { secretBase32 } = await createTotpEnrollment('lekar@example.cz')
    const prvni = await renderTotpEnrollment(secretBase32, 'lekar@example.cz')
    const druhy = await renderTotpEnrollment(secretBase32, 'lekar@example.cz')

    expect(prvni.uri).toBe(druhy.uri)
    expect(prvni.qrDataUrl).toBe(druhy.qrDataUrl)
  })

  it('potvrzenému uživateli nejde tajemství přepsat', async () => {
    // Zámek proti obejití druhého faktoru: kdo zná jen heslo, dostane relaci
    // po prvním faktoru. Kdyby si přes nastavení 2FA mohl zaregistrovat vlastní
    // tajemství, druhý faktor oběti by tím obešel. Podmínka na prázdné
    // totpConfirmedAt to drží i při souběhu dvou požadavků.
    const puvodni = await createTotpEnrollment('lekar@example.cz')

    await ownerClient.user.update({
      where: { id: a.user.id },
      data: {
        totpSecretEnc: encryptField(puvodni.secretBase32),
        totpConfirmedAt: new Date(),
      },
    })

    const utocnikovo = await createTotpEnrollment('lekar@example.cz')

    const { count } = await withPractice(a.practice.id, (db) =>
      db.user.updateMany({
        where: { id: a.user.id, totpConfirmedAt: null },
        data: { totpSecretEnc: encryptField(utocnikovo.secretBase32) },
      }),
    )

    expect(count).toBe(0)

    const po = await ownerClient.user.findUnique({
      where: { id: a.user.id },
      select: { totpSecretEnc: true },
    })
    expect(Buffer.from(po!.totpSecretEnc!).equals(Buffer.from(encryptField(puvodni.secretBase32)))).toBe(
      false,
    )
    // Šifrování je náhodné, takže se porovnává rozšifrovaná hodnota.
    const { decryptField } = await import('@/lib/crypto')
    expect(decryptField(po!.totpSecretEnc!)).toBe(puvodni.secretBase32)
  })
})
