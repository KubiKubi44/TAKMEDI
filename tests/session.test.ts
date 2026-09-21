import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashToken } from '@/lib/crypto'
import { appClient, resolverClient } from '@/lib/db'
import {
  confirmTotpAndRotate,
  createSession,
  findActiveSession,
  revokeAllSessions,
  revokeSession,
  touchSession,
} from '@/lib/session'
import { createPractice, ownerClient, removePractice } from './helpers'

/**
 * Přihlašovací relace.
 *
 * Relace je řádek v databázi, ne podepsaný token v cookie, takže se dá všechno
 * podstatné ověřit přímo dotazem: co v tabulce je, co v ní naopak není a odkdy
 * relace přestane platit.
 */

const KONTEXT = { ip: '198.51.100.7', userAgent: 'vitest' }
const IDLE_MINUTES = 30

let ordinace: Awaited<ReturnType<typeof createPractice>>
let pocitadloUzivatelu = 0

/**
 * Uživatel navíc pro testy, které ho zablokují nebo ho odhlásí ze všech
 * zařízení. Sdílený uživatel by tím přišel o relace ostatních testů.
 */
async function novyUzivatel(jmeno: string): Promise<string> {
  pocitadloUzivatelu += 1
  const uzivatel = await ownerClient.user.create({
    data: {
      practiceId: ordinace.practice.id,
      email: `relace-${Date.now()}-${pocitadloUzivatelu}@test.invalid`,
      passwordHash: 'x',
      name: jmeno,
      roles: ['DOCTOR'],
    },
  })
  return uzivatel.id
}

async function zaloz(userId: string = ordinace.user.id) {
  return createSession({ userId, idleMinutes: IDLE_MINUTES, context: KONTEXT })
}

function radek(id: string) {
  return ownerClient.session.findUniqueOrThrow({ where: { id } })
}

beforeAll(async () => {
  ordinace = await createPractice('Relace')
})

afterAll(async () => {
  if (ordinace) await removePractice(ordinace.practice.id)
  await ownerClient.$disconnect()
  await resolverClient.$disconnect()
  await appClient.$disconnect()
})

describe('založení a dohledání', () => {
  it('relaci založenou po hesle najde findActiveSession() podle tokenu', async () => {
    const { token, absoluteExpiresAt } = await zaloz()

    const relace = await findActiveSession(token)

    expect(relace).not.toBeNull()
    expect(relace!.userId).toBe(ordinace.user.id)
    expect(relace!.user.email).toBe(ordinace.user.email)
    expect(relace!.practice.id).toBe(ordinace.practice.id)
    expect(relace!.practice.sessionIdleMinutes).toBe(30)
    // Druhý faktor po zadání hesla ještě neproběhl.
    expect(relace!.totpVerified).toBe(false)
    expect(absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('v databázi je jen hash tokenu, nikdy token samotný', async () => {
    const { token } = await zaloz()

    const [ulozeno] = await ownerClient.$queryRaw<
      { token_hash: string; cely_radek: string }[]
    >`
      SELECT token_hash, to_jsonb(s)::text AS cely_radek
      FROM session s
      WHERE token_hash = ${hashToken(token)}
    `

    expect(ulozeno).toBeDefined()
    expect(ulozeno!.token_hash).toBe(hashToken(token))
    expect(ulozeno!.token_hash).not.toBe(token)
    expect(ulozeno!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    // Token se nesmí objevit ani v žádném jiném sloupci řádku.
    expect(ulozeno!.cely_radek).not.toContain(token)
  })

  it('neexistující token vrátí null', async () => {
    expect(await findActiveSession('tohle-nikdy-nikdo-nevydal')).toBeNull()
    expect(await findActiveSession('')).toBeNull()
  })
})

describe('konec platnosti', () => {
  it('zneplatněná relace vrátí null', async () => {
    const { token } = await zaloz()
    const relace = await findActiveSession(token)

    await revokeSession(relace!.id)

    expect(await findActiveSession(token)).toBeNull()
  })

  it('vypršená klouzavá expirace vrátí null, i když tvrdý strop ještě platí', async () => {
    const { token } = await zaloz()
    const relace = await findActiveSession(token)

    await ownerClient.session.update({
      where: { id: relace!.id },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    })

    const stav = await radek(relace!.id)
    expect(stav.absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await findActiveSession(token)).toBeNull()
  })

  it('vypršený tvrdý strop vrátí null, i když se klouzavá expirace posouvá', async () => {
    const { token } = await zaloz()
    const relace = await findActiveSession(token)

    const dovnitr = new Date(Date.now() - 5 * 60 * 1000)
    await ownerClient.session.update({
      where: { id: relace!.id },
      data: { absoluteExpiresAt: new Date(Date.now() - 1000), lastSeenAt: dovnitr },
    })

    // Aktivita klouzavou expiraci poslušně posune, tvrdý strop ale platí dál.
    await touchSession({
      sessionId: relace!.id,
      lastSeenAt: dovnitr,
      idleMinutes: IDLE_MINUTES,
    })

    const stav = await radek(relace!.id)
    expect(stav.idleExpiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await findActiveSession(token)).toBeNull()
  })

  it('zablokovaný uživatel vrátí null, i když je relace jinak v pořádku', async () => {
    const userId = await novyUzivatel('Zablokovaný')
    const { token } = await zaloz(userId)

    expect(await findActiveSession(token)).not.toBeNull()

    await ownerClient.user.update({ where: { id: userId }, data: { status: 'DISABLED' } })

    expect(await findActiveSession(token)).toBeNull()

    const stav = await ownerClient.session.findFirstOrThrow({ where: { userId } })
    expect(stav.revokedAt).toBeNull()
    expect(stav.idleExpiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('potvrzení druhého faktoru', () => {
  it('vymění token: starý přestane platit okamžitě a platí nový', async () => {
    // Nejdůležitější test souboru. Relace vzniká už po zadání hesla, takže
    // kdyby token zůstal stejný, hodnota podstrčená oběti před přihlášením by
    // po ověření druhého faktoru začala platit naplno – session fixation.
    const { token: puvodni } = await zaloz()
    const relace = await findActiveSession(puvodni)

    const novy = await confirmTotpAndRotate(relace!.id)

    expect(novy).not.toBe(puvodni)
    expect(await findActiveSession(puvodni)).toBeNull()

    const po = await findActiveSession(novy)
    expect(po).not.toBeNull()
    // Vyměnil se token, ne řádek – relace si nese svou historii dál.
    expect(po!.id).toBe(relace!.id)
    expect(po!.totpVerified).toBe(true)

    const stav = await radek(relace!.id)
    expect(stav.tokenHash).toBe(hashToken(novy))
    expect(stav.tokenHash).not.toBe(hashToken(puvodni))
  })
})

describe('posun klouzavé expirace', () => {
  it('touchSession() posune idleExpiresAt', async () => {
    const { token } = await zaloz()
    const relace = await findActiveSession(token)

    // Relace se právě založila, takže by ji škrticí okno neprošlo. Posunutím
    // lastSeenAt do minulosti se simuluje uživatel, který se po chvíli vrátil.
    const dovnitr = new Date(Date.now() - 5 * 60 * 1000)
    await ownerClient.session.update({
      where: { id: relace!.id },
      data: { lastSeenAt: dovnitr },
    })
    const pred = await radek(relace!.id)

    await touchSession({
      sessionId: relace!.id,
      lastSeenAt: dovnitr,
      idleMinutes: IDLE_MINUTES,
    })

    const po = await radek(relace!.id)
    expect(po.idleExpiresAt.getTime()).toBeGreaterThan(pred.idleExpiresAt.getTime())
    expect(po.lastSeenAt.getTime()).toBeGreaterThan(dovnitr.getTime())
  })

  it('opakované volání hned po sobě už nezapisuje', async () => {
    const { token } = await zaloz()
    const relace = await findActiveSession(token)

    await ownerClient.session.update({
      where: { id: relace!.id },
      data: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) },
    })
    await touchSession({
      sessionId: relace!.id,
      lastSeenAt: new Date(Date.now() - 5 * 60 * 1000),
      idleMinutes: IDLE_MINUTES,
    })
    const poPrvnim = await radek(relace!.id)

    // Škrticí okno je 60 sekund. Bez něj by každé otevření stránky znamenalo
    // zápis do databáze.
    for (let i = 0; i < 3; i++) {
      await touchSession({
        sessionId: relace!.id,
        lastSeenAt: poPrvnim.lastSeenAt,
        idleMinutes: IDLE_MINUTES,
      })
    }

    const poDalsich = await radek(relace!.id)
    expect(poDalsich.lastSeenAt.getTime()).toBe(poPrvnim.lastSeenAt.getTime())
    expect(poDalsich.idleExpiresAt.getTime()).toBe(poPrvnim.idleExpiresAt.getTime())
  })
})

describe('odhlášení ze všech zařízení', () => {
  it('revokeAllSessions() zneplatní všechny relace uživatele naráz', async () => {
    const userId = await novyUzivatel('Tři zařízení')
    const tokeny = [
      (await zaloz(userId)).token,
      (await zaloz(userId)).token,
      (await zaloz(userId)).token,
    ]

    for (const token of tokeny) {
      expect(await findActiveSession(token)).not.toBeNull()
    }

    const pocet = await revokeAllSessions(userId)
    expect(pocet).toBe(3)

    for (const token of tokeny) {
      expect(await findActiveSession(token)).toBeNull()
    }

    // Relace cizího uživatele zůstávají netknuté.
    const { token: jiny } = await zaloz()
    expect(await findActiveSession(jiny)).not.toBeNull()
  })
})
