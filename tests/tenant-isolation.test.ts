import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appClient, currentPracticeId, withPractice } from '@/lib/db'
import { createPractice, ownerClient, removePractice } from './helpers'

/**
 * Oddělení ordinací.
 *
 * Tyhle testy schválně NEPOUŽÍVAJÍ filtr podle ordinace v dotazech. Ověřují
 * totiž právě to, že izolace drží i tehdy, když ho programátor zapomene –
 * tedy že ji vynucuje databáze, a ne pozornost při psaní kódu.
 */

let a: Awaited<ReturnType<typeof createPractice>>
let b: Awaited<ReturnType<typeof createPractice>>
let packageA: string
let packageB: string

beforeAll(async () => {
  a = await createPractice('Ordinace A')
  b = await createPractice('Ordinace B')

  const pa = await ownerClient.package.create({
    data: { practiceId: a.practice.id, createdById: a.user.id },
  })
  const pb = await ownerClient.package.create({
    data: { practiceId: b.practice.id, createdById: b.user.id },
  })
  packageA = pa.id
  packageB = pb.id
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  if (b) await removePractice(b.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
})

describe('kontext ordinace', () => {
  it('uvnitř bloku platí, mimo něj ne', async () => {
    const inside = await withPractice(a.practice.id, (db) => currentPracticeId(db))
    expect(inside).toBe(a.practice.id)

    const outside = await currentPracticeId(appClient)
    expect(outside).toBeNull()
  })

  it('nepřetéká mezi dvěma po sobě jdoucími bloky', async () => {
    await withPractice(a.practice.id, async (db) => {
      expect(await currentPracticeId(db)).toBe(a.practice.id)
    })
    await withPractice(b.practice.id, async (db) => {
      expect(await currentPracticeId(db)).toBe(b.practice.id)
    })
  })
})

describe('čtení', () => {
  it('bez kontextu ordinace se nevrátí nic', async () => {
    // Fail-closed: chyba v aplikaci vede k prázdnému výsledku, ne k úniku.
    const balicky = await appClient.package.findMany()
    expect(balicky).toHaveLength(0)
  })

  it('dotaz BEZ filtru vrátí jen vlastní balíčky', async () => {
    const balicky = await withPractice(a.practice.id, (db) => db.package.findMany())

    expect(balicky.map((p) => p.id)).toEqual([packageA])
    expect(balicky.map((p) => p.id)).not.toContain(packageB)
  })

  it('cizí balíček nejde přečíst ani podle přesného id', async () => {
    const nalezeny = await withPractice(a.practice.id, (db) =>
      db.package.findUnique({ where: { id: packageB } }),
    )
    expect(nalezeny).toBeNull()
  })

  it('cizí uživatel není vidět ani při hledání podle e-mailu', async () => {
    const nalezeny = await withPractice(a.practice.id, (db) =>
      db.user.findUnique({ where: { email: b.user.email } }),
    )
    expect(nalezeny).toBeNull()
  })

  it('počítání přes celou tabulku vidí jen vlastní ordinaci', async () => {
    const pocet = await withPractice(a.practice.id, (db) => db.package.count())
    expect(pocet).toBe(1)
  })
})

describe('zápis', () => {
  it('nejde založit balíček cizí ordinaci', async () => {
    await expect(
      withPractice(a.practice.id, (db) =>
        db.package.create({
          data: { practiceId: b.practice.id, createdById: b.user.id },
        }),
      ),
    ).rejects.toThrow()
  })

  it('cizí balíček nejde změnit ani hromadnou úpravou bez filtru', async () => {
    await withPractice(a.practice.id, (db) =>
      db.package.updateMany({ data: { status: 'REVOKED' } }),
    )

    const cizi = await ownerClient.package.findUnique({ where: { id: packageB } })
    expect(cizi?.status).toBe('DRAFT')
  })

  it('cizí balíček nejde smazat ani hromadným mazáním bez filtru', async () => {
    await withPractice(a.practice.id, (db) => db.package.deleteMany({}))

    const cizi = await ownerClient.package.findUnique({ where: { id: packageB } })
    expect(cizi).not.toBeNull()
  })
})

describe('session', () => {
  it('aplikační role nemá na přihlášení vůbec žádná práva', async () => {
    // Session čte a zapisuje výhradně rozlišovací role. Aplikační role se tak
    // k cizím přihlášením nedostane ani omylem.
    await expect(
      withPractice(a.practice.id, (db) => db.session.findMany()),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('audit', () => {
  it('zapsat jde, přepsat ani smazat ne', async () => {
    await withPractice(a.practice.id, (db) =>
      db.auditLog.create({
        data: {
          practiceId: a.practice.id,
          action: 'PACKAGE_CREATED',
          actorType: 'USER',
          actorUserId: a.user.id,
          actorName: a.user.name,
        },
      }),
    )

    await expect(
      withPractice(a.practice.id, (db) =>
        db.auditLog.updateMany({ data: { action: 'LOGIN_SUCCESS' } }),
      ),
    ).rejects.toThrow()

    await expect(
      withPractice(a.practice.id, (db) => db.auditLog.deleteMany({})),
    ).rejects.toThrow()
  })

  it('hashový řetěz navazuje a databáze ho doplňuje sama', async () => {
    const practiceId = a.practice.id

    await withPractice(practiceId, async (db) => {
      await db.auditLog.create({
        data: { practiceId, action: 'PACKAGE_PRINTED', actorType: 'USER', actorUserId: a.user.id },
      })
      await db.auditLog.create({
        data: { practiceId, action: 'HANDOFF_ACTIVATED', actorType: 'USER', actorUserId: a.user.id },
      })
    })

    const zaznamy = await withPractice(practiceId, (db) =>
      db.auditLog.findMany({ orderBy: { seq: 'asc' } }),
    )

    expect(zaznamy.length).toBeGreaterThanOrEqual(3)

    for (const [index, zaznam] of zaznamy.entries()) {
      expect(zaznam.seq).toBe(BigInt(index + 1))
      expect(zaznam.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(zaznam.prevHash).toBe(index === 0 ? null : zaznamy[index - 1]!.hash)
    }
  })

  it('audit druhé ordinace není vidět', async () => {
    const zaznamy = await withPractice(b.practice.id, (db) => db.auditLog.findMany())
    expect(zaznamy).toHaveLength(0)
  })
})
