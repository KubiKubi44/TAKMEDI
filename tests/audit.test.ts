import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeAnonymousAudit, writeAudit } from '@/lib/audit'
import { appClient, resolverClient, withPractice } from '@/lib/db'
import { createPractice, ownerClient, removePractice } from './helpers'

/**
 * Zápis do auditu pod správnou rolí.
 *
 * Tyhle testy existují kvůli konkrétní pasti: Prisma vydá pro create() jediný
 * příkaz INSERT ... RETURNING <všechny sloupce>, což PostgreSQL neprovede bez
 * práva SELECT. Rozlišovací role SELECT na audit_log nemá, takže create() pod
 * ní spadne – a chyba se ohlásí jako „permission denied for table audit_log“,
 * což svádí k domněnce, že chybí právo INSERT.
 */

let a: Awaited<ReturnType<typeof createPractice>>

beforeAll(async () => {
  a = await createPractice('Audit')
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
  await resolverClient.$disconnect()
})

describe('událost patřící ordinaci', () => {
  it('projde pod aplikační rolí a zařadí se do řetězu', async () => {
    await withPractice(a.practice.id, (db) =>
      writeAudit(db, a.practice.id, {
        action: 'LOGIN_SUCCESS',
        actorType: 'USER',
        actorUserId: a.user.id,
        actorName: a.user.name,
        metadata: { druh: 'test' },
      }),
    )

    const zaznamy = await withPractice(a.practice.id, (db) => db.auditLog.findMany())

    expect(zaznamy).toHaveLength(1)
    expect(zaznamy[0]!.action).toBe('LOGIN_SUCCESS')
    expect(zaznamy[0]!.seq).toBe(1n)
    expect(zaznamy[0]!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(zaznamy[0]!.actorName).toBe(a.user.name)
  })

  it('rozlišovací role ji zapsat NESMÍ', async () => {
    // Dva nezávislé důvody: chybí SELECT kvůli RETURNING, a funkce hashového
    // řetězu čte poslední záznam ordinace, na což taky potřebuje SELECT.
    await expect(
      resolverClient.auditLog.createMany({
        data: [
          {
            practiceId: a.practice.id,
            action: 'LOGIN_FAILED',
            actorType: 'SYSTEM',
          },
        ],
      }),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('událost bez ordinace', () => {
  it('create() pod rozlišovací rolí selže kvůli RETURNING', async () => {
    await expect(
      resolverClient.auditLog.create({
        data: { practiceId: null, action: 'LOGIN_FAILED', actorType: 'SYSTEM' },
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('createMany() projde, protože nevydá RETURNING', async () => {
    await writeAnonymousAudit({
      action: 'LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorName: 'neznamy@example.cz',
      metadata: { duvod: 'neznamy_email' },
      context: { ip: '198.51.100.7', userAgent: 'test' },
    })

    const zapsano = await ownerClient.auditLog.findFirst({
      where: { practiceId: null, actorName: 'neznamy@example.cz' },
      orderBy: { id: 'desc' },
    })

    expect(zapsano).not.toBeNull()
    expect(zapsano!.seq).toBeNull()
    expect(zapsano!.prevHash).toBeNull()
    expect(zapsano!.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('aplikační role se k záznamům bez ordinace nedostane', async () => {
    const videno = await withPractice(a.practice.id, (db) =>
      db.auditLog.findMany({ where: { practiceId: null } }),
    )
    expect(videno).toHaveLength(0)
  })
})
