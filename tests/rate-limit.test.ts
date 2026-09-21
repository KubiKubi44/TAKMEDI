import { afterAll, describe, expect, it } from 'vitest'

import { hmacSecret } from '@/lib/crypto'
import { appClient, resolverClient } from '@/lib/db'
import { clearRateLimit, hitRateLimit } from '@/lib/rate-limit'
import { ownerClient } from './helpers'

/**
 * Omezování četnosti pokusů.
 *
 * Počítadla jsou řádky v PostgreSQL, takže se dá ověřit obojí: že posuvné okno
 * počítá správně a že v tabulce nezůstává nic, z čeho by šlo přečíst, kdo se
 * odkud pokoušel přihlásit.
 */

/** Klíče použité v testech – afterAll po sobě uklidí jen je. */
const pouziteKlice = new Set<string>()
let pocitadlo = 0

/** Každý test má vlastní identifikátor, aby na sebe testy nenavazovaly. */
function identifikator(popis: string): string {
  pocitadlo += 1
  return `${popis}-${Date.now()}-${pocitadlo}`
}

async function pokus(params: {
  action: string
  identifier: string
  limit: number
  windowSeconds: number
}) {
  pouziteKlice.add(hmacSecret(`${params.action}:${params.identifier}`))
  return hitRateLimit(params)
}

function pockej(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterAll(async () => {
  await ownerClient.rateLimit.deleteMany({ where: { key: { in: [...pouziteKlice] } } })
  await ownerClient.$disconnect()
  await resolverClient.$disconnect()
  await appClient.$disconnect()
})

describe('počítání pokusů', () => {
  it('pustí prvních limit pokusů a další už ne', async () => {
    const action = 'test-prihlaseni'
    const identifier = identifikator('lekar')

    for (let i = 1; i <= 3; i++) {
      const vysledek = await pokus({ action, identifier, limit: 3, windowSeconds: 60 })
      expect(vysledek.allowed).toBe(true)
      expect(vysledek.count).toBe(i)
    }

    const ctvrty = await pokus({ action, identifier, limit: 3, windowSeconds: 60 })
    expect(ctvrty.allowed).toBe(false)
    expect(ctvrty.count).toBe(4)
    expect(ctvrty.retryAfterSeconds).toBeGreaterThan(0)
    expect(ctvrty.retryAfterSeconds).toBeLessThanOrEqual(60)

    // Další pokusy počítadlo dál zvyšují, ale nic nepustí.
    const paty = await pokus({ action, identifier, limit: 3, windowSeconds: 60 })
    expect(paty.allowed).toBe(false)
    expect(paty.count).toBe(5)
  })

  it('počítadla dvou identifikátorů se navzájem neovlivňují', async () => {
    const action = 'test-oddeleni'
    const prvni = identifikator('ip-a')
    const druhy = identifikator('ip-b')

    await pokus({ action, identifier: prvni, limit: 1, windowSeconds: 60 })
    const zablokovany = await pokus({ action, identifier: prvni, limit: 1, windowSeconds: 60 })
    expect(zablokovany.allowed).toBe(false)

    const cizi = await pokus({ action, identifier: druhy, limit: 1, windowSeconds: 60 })
    expect(cizi.allowed).toBe(true)
    expect(cizi.count).toBe(1)
  })

  it('po uplynutí okna se počítadlo resetuje', async () => {
    const action = 'test-okno'
    const identifier = identifikator('kod')

    expect((await pokus({ action, identifier, limit: 1, windowSeconds: 1 })).allowed).toBe(true)
    expect((await pokus({ action, identifier, limit: 1, windowSeconds: 1 })).allowed).toBe(false)

    await pockej(1200)

    const poOkne = await pokus({ action, identifier, limit: 1, windowSeconds: 1 })
    expect(poOkne.allowed).toBe(true)
    expect(poOkne.count).toBe(1)
  })

  it('clearRateLimit() počítadlo vynuluje', async () => {
    const action = 'test-uspech'
    const identifier = identifikator('lekar')

    await pokus({ action, identifier, limit: 1, windowSeconds: 3600 })
    expect((await pokus({ action, identifier, limit: 1, windowSeconds: 3600 })).allowed).toBe(false)

    await clearRateLimit(action, identifier)

    const radek = await ownerClient.rateLimit.findUnique({
      where: { key: hmacSecret(`${action}:${identifier}`) },
    })
    expect(radek).toBeNull()

    const po = await pokus({ action, identifier, limit: 1, windowSeconds: 3600 })
    expect(po.allowed).toBe(true)
    expect(po.count).toBe(1)
  })
})

describe('souběh', () => {
  it('při dvaceti současných pokusech projde přesně limit z nich', async () => {
    // Tohle je vlastní důvod, proč je počítadlo jediný příkaz
    // INSERT ... ON CONFLICT DO UPDATE. Přes prisma.upsert se posuvné okno
    // napsat nedá: jeho update umí jen bezpodmínečný přírůstek, takže by reset
    // okna potřeboval napřed dotaz a teprve pak zápis – a mezi ně by se vešel
    // souběžný pokus. Ten by pak počítadlo přepsal a limit by se dal obejít
    // prostým odesláním všech pokusů najednou.
    const action = 'test-soubeh'
    const identifier = identifikator('utocnik')
    const limit = 5

    const vysledky = await Promise.all(
      Array.from({ length: 20 }, () =>
        pokus({ action, identifier, limit, windowSeconds: 60 }),
      ),
    )

    expect(vysledky.filter((v) => v.allowed)).toHaveLength(limit)

    // Každý pokus dostal vlastní pořadové číslo, žádný zápis se neztratil.
    const cisla = vysledky.map((v) => v.count).sort((a, b) => a - b)
    expect(cisla).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))

    const radek = await ownerClient.rateLimit.findUniqueOrThrow({
      where: { key: hmacSecret(`${action}:${identifier}`) },
    })
    expect(radek.count).toBe(20)
  })
})

describe('obsah tabulky', () => {
  it('identifikátor se ukládá jen jako HMAC', async () => {
    const email = `sestra-${Date.now()}@priklad.cz`
    const ip = '203.0.113.42'
    const action = 'test-hmac'

    await pokus({ action, identifier: email, limit: 5, windowSeconds: 60 })
    await pokus({ action, identifier: ip, limit: 5, windowSeconds: 60 })

    const klic = hmacSecret(`${action}:${email}`)
    expect(klic).toMatch(/^[0-9a-f]{64}$/)
    expect(await ownerClient.rateLimit.findUnique({ where: { key: klic } })).not.toBeNull()

    // Celý obsah tabulky, ne jen klíč: e-mail ani IP se nesmí objevit v žádném
    // sloupci. Únik databáze tak neprozradí, kdo se odkud pokoušel přihlásit.
    const radky = await ownerClient.$queryRaw<{ cely_radek: string }[]>`
      SELECT to_jsonb(r)::text AS cely_radek FROM rate_limit r
    `
    const tabulka = radky.map((r) => r.cely_radek).join('\n')

    expect(tabulka).not.toContain(email)
    expect(tabulka).not.toContain(ip)
    expect(tabulka).not.toContain(action)
  })
})
