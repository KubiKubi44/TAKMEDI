import { describe, expect, it } from 'vitest'

import {
  decryptField,
  decryptFile,
  encryptField,
  encryptFile,
  generateAccessToken,
  generateHandoffCode,
  generatePin,
  hashToken,
  hmacSecret,
  secretMatches,
} from '@/lib/crypto'

describe('náhodná tajemství', () => {
  it('pacientský token má 256 bitů entropie', () => {
    const token = generateAccessToken()
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })

  it('tokeny se neopakují', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateAccessToken))
    expect(tokens.size).toBe(1000)
  })

  it('kód předání je vždy čtyřmístný včetně vedoucích nul', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateHandoffCode()
      expect(code).toMatch(/^\d{4}$/)
    }
  })

  it('PIN je vždy šestimístný', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePin()).toMatch(/^\d{6}$/)
    }
  })

  it('kódy jsou rozložené rovnoměrně po celém rozsahu', () => {
    // Kdyby se kód generoval jako randomBytes % 10000, nižší hodnoty by byly
    // častější. Test proto měří rozložení, ne jen rozsah: rozdělí 0000–9999 na
    // deset stejných přihrádek a hlídá, že se žádná výrazně nevymyká.
    const DRAWS = 50_000
    const BUCKETS = 10
    const expected = DRAWS / BUCKETS

    const counts = new Array<number>(BUCKETS).fill(0)
    for (let i = 0; i < DRAWS; i++) {
      const code = generateHandoffCode()
      expect(code).toMatch(/^\d{4}$/)
      counts[Math.floor(Number(code) / (10_000 / BUCKETS))]! += 1
    }

    // Směrodatná odchylka jedné přihrádky je zhruba 67, pět odchylek je tedy
    // s velkou rezervou nad šumem a přitom hluboko pod posunem, který by
    // způsobilo modulo.
    const tolerance = 5 * Math.sqrt(expected * (1 - 1 / BUCKETS))
    for (const count of counts) {
      expect(Math.abs(count - expected)).toBeLessThan(tolerance)
    }
  })
})

describe('hashování tajemství', () => {
  it('hash tokenu je stabilní a nevrací původní hodnotu', () => {
    const token = generateAccessToken()
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toContain(token)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('HMAC krátkého tajemství sedí jen na správnou hodnotu', () => {
    const stored = hmacSecret('4821')
    expect(secretMatches('4821', stored)).toBe(true)
    expect(secretMatches('4822', stored)).toBe(false)
    expect(secretMatches('', stored)).toBe(false)
  })

  it('porovnání nespadne na hodnotě jiné délky', () => {
    expect(secretMatches('4821', 'krátký-hash')).toBe(false)
  })
})

describe('šifrování polí', () => {
  it('jméno pacienta se zašifruje a zase přečte', () => {
    const encrypted = encryptField('Jan Novák')
    expect(decryptField(encrypted)).toBe('Jan Novák')
  })

  it('stejná hodnota dá pokaždé jiný šifrový text', () => {
    // Deterministické šifrování by prozradilo, kteří pacienti se opakují.
    const a = Buffer.from(encryptField('Jan Novák'))
    const b = Buffer.from(encryptField('Jan Novák'))
    expect(a.equals(b)).toBe(false)
  })

  it('poškozený šifrový text se odmítne, nevrátí nesmysl', () => {
    const encrypted = encryptField('Jan Novák')
    const last = encrypted.length - 1
    encrypted[last] = encrypted[last]! ^ 0xff
    expect(() => decryptField(encrypted)).toThrow()
  })
})

describe('obálkové šifrování souborů', () => {
  const content = Buffer.from('%PDF-1.7 obsah lékařské zprávy')

  it('soubor se zašifruje a zase přečte', () => {
    const key = 'ordinace/a/zprava.pdf'
    const enc = encryptFile(content, key)

    expect(enc.ciphertext.equals(content)).toBe(false)
    expect(decryptFile({ ...enc, storageKey: key }).equals(content)).toBe(true)
  })

  it('soubor nejde přečíst pod cizí cestou v úložišti', () => {
    // Cesta vstupuje do šifrování jako doplňková autentizovaná data, takže
    // prohození dvou blobů mezi záznamy v databázi neprojde.
    const enc = encryptFile(content, 'ordinace/a/zprava.pdf')
    expect(() => decryptFile({ ...enc, storageKey: 'ordinace/b/zprava.pdf' })).toThrow()
  })

  it('každý soubor má vlastní klíč', () => {
    const a = encryptFile(content, 'a.pdf')
    const b = encryptFile(content, 'b.pdf')
    expect(Buffer.from(a.dekWrapped).equals(Buffer.from(b.dekWrapped))).toBe(false)
  })

  it('poškozený obsah se odmítne', () => {
    const key = 'a.pdf'
    const enc = encryptFile(content, key)
    enc.ciphertext.writeUInt8(enc.ciphertext.readUInt8(0) ^ 0xff, 0)
    expect(() => decryptFile({ ...enc, storageKey: key })).toThrow()
  })
})
