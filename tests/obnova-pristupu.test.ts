import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Obnova přístupu k účtu – nové heslo a zrušení druhého faktoru.
 *
 * Tyhle dvě akce přihlašovací obrazovky slibují („heslo vám nastaví správce
 * ordinace", „druhý faktor vám zruší správce ordinace") a dlouho neexistovaly.
 * Bez nich byl člověk, který přišel o telefon, z aplikace zamčený nadobro,
 * protože dvoufázové přihlášení je povinné.
 *
 * Testy volají Server Actions přímo. Chybí jim jen zdroj hlaviček a cookie,
 * které jinak dodá Next.js – ten se tu podvrhne, takže projde celá skutečná
 * cesta včetně kontroly původu, role a row-level security.
 */

const pozadavek = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
}))

vi.mock('next/headers', () => ({
  headers: async () => pozadavek.headers,
  cookies: async () => ({
    get(name: string) {
      const value = pozadavek.cookies.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set() {
      throw new Error('Obnova přístupu nemá zapisovat cookie.')
    },
    delete() {
      throw new Error('Obnova přístupu nemá mazat cookie.')
    },
  }),
}))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { resetUserPassword, resetUserTotp } from '@/app/nastaveni/actions'
import { hashToken } from '@/lib/crypto'
import { appClient, resolverClient } from '@/lib/db'
import { env } from '@/lib/env'
import { verifyPassword } from '@/lib/password'
import { SESSION_COOKIE } from '@/lib/session'
import { createPractice, ownerClient, removePractice } from './helpers'

let a: Awaited<ReturnType<typeof createPractice>>
let adminId: string
let sestraId: string
let adminToken: string

async function prihlas(userId: string): Promise<string> {
  const token = randomUUID()
  const nyni = Date.now()

  await ownerClient.user.update({
    where: { id: userId },
    data: { totpConfirmedAt: new Date() },
  })
  await ownerClient.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      totpVerifiedAt: new Date(),
      idleExpiresAt: new Date(nyni + 3600_000),
      absoluteExpiresAt: new Date(nyni + 12 * 3600_000),
    },
  })

  return token
}

async function jako<T>(token: string | null, prace: () => Promise<T>): Promise<T> {
  pozadavek.headers = new Headers({ origin: env.APP_URL, 'user-agent': 'vitest' })
  pozadavek.cookies.clear()
  if (token) pozadavek.cookies.set(SESSION_COOKIE, token)

  try {
    return await prace()
  } finally {
    pozadavek.headers = new Headers()
    pozadavek.cookies.clear()
  }
}

function pole(userId: string): FormData {
  const data = new FormData()
  data.set('userId', userId)
  return data
}

beforeAll(async () => {
  a = await createPractice('Obnova')
  adminId = a.user.id
  await ownerClient.user.update({
    where: { id: adminId },
    data: { roles: ['DOCTOR', 'PRACTICE_ADMIN'] },
  })

  const sestra = await ownerClient.user.create({
    data: {
      practiceId: a.practice.id,
      email: `sestra-${randomUUID()}@test.invalid`,
      passwordHash: 'x',
      name: 'Sestra Dvořáková',
      roles: ['NURSE'],
    },
  })
  sestraId = sestra.id

  adminToken = await prihlas(adminId)
})

afterAll(async () => {
  if (a) await removePractice(a.practice.id)
  await ownerClient.$disconnect()
  await appClient.$disconnect()
  await resolverClient.$disconnect()
})

describe('nové heslo', () => {
  it('nastaví heslo, které opravdu funguje, a vrátí ho jen jednou', async () => {
    const stav = await jako(adminToken, () => resetUserPassword({}, pole(sestraId)))

    expect(stav.noveHeslo?.jmeno).toBe('Sestra Dvořáková')
    const heslo = stav.noveHeslo!.heslo
    expect(heslo.length).toBeGreaterThan(15)

    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: sestraId } })
    // Heslo je v databázi jen jako argon2id hash, ale ověřit se jím dá.
    expect(po.passwordHash).not.toContain(heslo)
    expect(await verifyPassword(po.passwordHash, heslo)).toBe(true)
  })

  it('odemkne účet zamčený po několika překlepech', async () => {
    await ownerClient.user.update({
      where: { id: sestraId },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 3600_000) },
    })

    await jako(adminToken, () => resetUserPassword({}, pole(sestraId)))

    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: sestraId } })
    expect(po.failedLoginCount).toBe(0)
    expect(po.lockedUntil).toBeNull()
  })

  it('odhlásí uživatele ze všech zařízení', async () => {
    // Kdo žádá o obnovu přístupu, má typicky podezření, že se k účtu dostal
    // někdo další. Ponechat běžící přihlášení by obnovu vyprázdnilo.
    const sestraToken = await prihlas(sestraId)
    expect(
      await ownerClient.session.count({ where: { userId: sestraId, revokedAt: null } }),
    ).toBe(1)

    await jako(adminToken, () => resetUserPassword({}, pole(sestraId)))

    expect(
      await ownerClient.session.count({ where: { userId: sestraId, revokedAt: null } }),
    ).toBe(0)
    expect(sestraToken).toBeTruthy()
  })
})

describe('zrušení druhého faktoru', () => {
  it('smaže tajemství i potvrzení, účet zůstane platný', async () => {
    await ownerClient.user.update({
      where: { id: sestraId },
      data: {
        totpConfirmedAt: new Date(),
        totpSecretEnc: Buffer.from('x'.repeat(60)),
        totpLastCounter: 42n,
      },
    })

    const stav = await jako(adminToken, () => resetUserTotp({}, pole(sestraId)))
    expect(stav.zruseno2fa?.jaSam).toBe(false)

    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: sestraId } })
    expect(po.totpConfirmedAt).toBeNull()
    expect(po.totpSecretEnc).toBeNull()
    expect(po.totpLastCounter).toBeNull()
    expect(po.status).toBe('ACTIVE')
  })

  it('admin to smí udělat i sám sobě', async () => {
    // V ordinaci bývá jediný. Kdyby to nešlo, po ztrátě telefonu by se
    // dovnitř nedostal nikdo.
    const stav = await jako(adminToken, () => resetUserTotp({}, pole(adminId)))

    expect(stav.zruseno2fa?.jaSam).toBe(true)
    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: adminId } })
    expect(po.totpConfirmedAt).toBeNull()

    // Přišel přitom o vlastní přihlášení – nový faktor si musí nastavit
    // průchodem od hesla.
    expect(await ownerClient.session.count({ where: { userId: adminId, revokedAt: null } })).toBe(0)

    adminToken = await prihlas(adminId)
  })

  it('zapíše se do auditu i se jménem dotčeného účtu', async () => {
    await jako(adminToken, () => resetUserTotp({}, pole(sestraId)))

    const zaznam = await ownerClient.auditLog.findFirst({
      where: { practiceId: a.practice.id, action: 'USER_UPDATED' },
      orderBy: { id: 'desc' },
    })

    const meta = zaznam!.metadata as Record<string, unknown>
    expect(meta.akce).toBe('zruseni_druheho_faktoru')
    expect(meta.jmeno).toBe('Sestra Dvořáková')
  })
})

describe('kdo to smí', () => {
  it('sestra ne', async () => {
    const sestraToken = await prihlas(sestraId)
    const pred = await ownerClient.user.findUniqueOrThrow({ where: { id: adminId } })

    // Ověřuje se ÚČINEK, ne třída výjimky. requireRole volá forbidden(),
    // které potřebuje konfiguraci Next.js (experimental.authInterrupts);
    // ta se v testech nenačítá, takže tu vyhodí jinou výjimku než v aplikaci.
    // Že sestra dostane 403, je ověřené průchodem běžící aplikací.
    await expect(
      jako(sestraToken, () => resetUserPassword({}, pole(adminId))),
    ).rejects.toThrow()

    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: adminId } })
    expect(po.passwordHash).toBe(pred.passwordHash)
  })

  it('nepřihlášený ne', async () => {
    // requireRole vede přes requireUser, který nepřihlášeného přesměruje –
    // a redirect() v Next vyhazuje vlastní výjimku.
    await expect(jako(null, () => resetUserPassword({}, pole(sestraId)))).rejects.toThrow()
  })

  it('bez hlavičky Origin ne', async () => {
    pozadavek.headers = new Headers({ 'user-agent': 'vitest' })
    pozadavek.cookies.set(SESSION_COOKIE, adminToken)

    const stav = await resetUserPassword({}, pole(sestraId))
    expect(stav.error).toContain('nepřišel z této aplikace')

    pozadavek.headers = new Headers()
    pozadavek.cookies.clear()
  })

  it('uživatel z cizí ordinace se najít nedá', async () => {
    const b = await createPractice('Obnova cizí')

    const stav = await jako(adminToken, () => resetUserPassword({}, pole(b.user.id)))
    expect(stav.error).toBe('Uživatele se nepodařilo najít.')

    // A jeho heslo zůstalo nedotčené.
    const po = await ownerClient.user.findUniqueOrThrow({ where: { id: b.user.id } })
    expect(po.passwordHash).toBe('x')

    await removePractice(b.practice.id)
  })
})
