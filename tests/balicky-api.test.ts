import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Route handlery balíčků – volané přímo, ne přes běžící server.
 *
 * Handler je obyčejná funkce, která dostane Request a vrátí Response, takže se
 * dá zavolat z testu. Chybí mu jen dvě věci, které jinak dodá Next.js: cookie
 * s relací (next/headers → cookies()) a hlavičky požadavku (headers()).
 * Oboje sem doplní podvržený modul níž, takže testem projde celá cesta
 * včetně getApiUser(), kontroly původu, row-level security i šifrování –
 * jediné, co se nahrazuje, je zdroj hlaviček.
 *
 * Proč ne požadavek na vývojový server: ten čte DATABASE_URL z .env, tedy
 * vývojovou databázi, kdežto testy běží nad samostatnou medpredani_test
 * (tests/setup.ts). Ordinace ani relace založené odsud by v jeho databázi
 * neexistovaly a jediný způsob, jak to obejít, by bylo zapisovat testovací
 * data do vývojové databáze. To je horší než přijít o pár kilometrů cesty
 * skrz Next.js – zvlášť když ta cesta (směrování, parsování multipartu,
 * limit těla) není nic, co by aplikace psala.
 */

/** Ambientní stav „právě obsluhovaného požadavku". Přepisuje ho vPozadavku(). */
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
    // Route handler balíčků cookie nemění. Kdyby to začal dělat, ať to test
    // ukáže hned, ne až v prohlížeči.
    set() {
      throw new Error('Obsluha balíčků nemá zapisovat cookie.')
    },
    delete() {
      throw new Error('Obsluha balíčků nemá mazat cookie.')
    },
  }),
}))

import { GET as tiskBalicku } from '@/app/api/balicky/[packageId]/tisk.pdf/route'
import { POST as nahrajZpravu } from '@/app/api/balicky/[packageId]/zprava/route'
import { POST as zalozBalicek, PUT as ulozBalicek } from '@/app/api/balicky/route'
import { hashToken } from '@/lib/crypto'
import { appClient, resolverClient, withPractice } from '@/lib/db'
import { env } from '@/lib/env'
import { uploadTemplateVersion } from '@/lib/library-documents'
import { loadPackage } from '@/lib/packages'
import { inspectPdf } from '@/lib/pdf'
import { clearRateLimit } from '@/lib/rate-limit'
import { SESSION_COOKIE } from '@/lib/session'
import { storage } from '@/lib/storage'
import { makePdf } from './fixtures/pdf'
import { createPractice, ownerClient, removePractice } from './helpers'

type Ordinace = Awaited<ReturnType<typeof createPractice>>

/** Co potřebuje volající, aby se tvářil jako přihlášený uživatel. */
type Prihlaseny = { practiceId: string; userId: string; token: string }

let a: Ordinace
let b: Ordinace
let lekarA: Prihlaseny
let sestraA: Prihlaseny
let lekarB: Prihlaseny
let problemA: string
let verzeA: string[] = []
let cizoVerze: string

const context = { ip: null, userAgent: null }

beforeAll(async () => {
  a = await createPractice('API balicky A')
  b = await createPractice('API balicky B')

  lekarA = await prihlas(a.user.id, a.practice.id)
  lekarB = await prihlas(b.user.id, b.practice.id)
  sestraA = await prihlas(
    await zalozUzivatele(a.practice.id, 'Sestra Dvořáková', ['NURSE']),
    a.practice.id,
  )

  problemA = (
    await ownerClient.problem.create({
      data: { practiceId: a.practice.id, name: 'Po operaci kolene', icd10: 'Z96.6' },
    })
  ).id
  const problemB = (
    await ownerClient.problem.create({ data: { practiceId: b.practice.id, name: 'Cizí problém' } })
  ).id

  for (const [nazev, stran] of [
    ['Pouceni', 2],
    ['Rezim', 1],
  ] as const) {
    const verze = await uploadTemplateVersion({
      practiceId: a.practice.id,
      userId: a.user.id,
      userName: a.user.name,
      context,
      problemId: problemA,
      title: nazev,
      bytes: await makePdf(nazev, stran),
      mimeType: 'application/pdf',
    })
    verzeA.push(verze.versionId)
  }

  cizoVerze = (
    await uploadTemplateVersion({
      practiceId: b.practice.id,
      userId: b.user.id,
      userName: b.user.name,
      context,
      problemId: problemB,
      title: 'Cizi dokument',
      bytes: await makePdf('Cizi', 1),
      mimeType: 'application/pdf',
    })
  ).versionId
}, 60_000)

afterAll(async () => {
  for (const ordinace of [a, b]) {
    if (!ordinace) continue
    await smazSoubory(ordinace.practice.id)
    await removePractice(ordinace.practice.id)
  }

  // Počítadla nahrávání přežívají smazání ordinace – žijí mimo ni, pod
  // rozlišovací rolí, a klíčem je otisk identifikátoru uživatele.
  for (const kdo of [lekarA, lekarB, sestraA]) {
    if (kdo) await clearRateLimit('zprava', kdo.userId)
  }

  await ownerClient.$disconnect()
  await appClient.$disconnect()
  await resolverClient.$disconnect()
})

/**
 * Uklidí zašifrovaný obsah z úložiště.
 *
 * Smazání ordinace se ho netýká – leží mimo databázi. A mazat ho podle cesty
 * nejde: souborový ovladač ukládá pod otisk klíče, ne pod čitelnou cestu
 * (viz src/lib/storage/filesystem.ts). Klíče se proto vyčtou z databáze.
 */
async function smazSoubory(practiceId: string): Promise<void> {
  const [verze, nahrane] = await Promise.all([
    ownerClient.templateDocumentVersion.findMany({
      where: { practiceId },
      select: { storageKey: true },
    }),
    ownerClient.uploadedFile.findMany({ where: { practiceId }, select: { storageKey: true } }),
  ])

  const ulozene = await storage()
  for (const { storageKey } of [...verze, ...nahrane]) {
    await ulozene.delete(storageKey).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Příprava přihlášených uživatelů
// ---------------------------------------------------------------------------

async function zalozUzivatele(
  practiceId: string,
  name: string,
  roles: ('DOCTOR' | 'NURSE' | 'PRACTICE_ADMIN')[],
): Promise<string> {
  const user = await ownerClient.user.create({
    data: {
      practiceId,
      email: `${randomUUID()}@test.invalid`,
      passwordHash: 'x',
      name,
      roles,
      totpConfirmedAt: new Date(),
    },
  })
  return user.id
}

/**
 * Vyrobí relaci zápisem řádku do databáze.
 *
 * Token se ukládá jen jako SHA-256 (viz src/lib/session.ts), takže se zapisuje
 * hashToken(token) a v testu zůstane čitelná hodnota do cookie. Zároveň se
 * dopíše totpConfirmedAt a totpVerifiedAt – bez druhého faktoru vrací
 * getApiUser() null a všechno by skončilo na 401.
 */
async function prihlas(userId: string, practiceId: string): Promise<Prihlaseny> {
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
      idleExpiresAt: new Date(nyni + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(nyni + 12 * 60 * 60 * 1000),
    },
  })

  return { practiceId, userId, token }
}

// ---------------------------------------------------------------------------
// Volání handlerů
// ---------------------------------------------------------------------------

type Kontext = {
  /** Kdo požadavek posílá. Chybějící hodnota znamená nepřihlášeného. */
  jako?: Prihlaseny
  /** Hlavička Origin. null = neposílat ji vůbec. */
  origin?: string | null
  secFetchSite?: string
}

async function vPozadavku<T>(kontext: Kontext, prace: () => Promise<T>): Promise<T> {
  const hlavicky = new Headers({ 'user-agent': 'vitest' })
  const origin = kontext.origin === undefined ? env.APP_URL : kontext.origin
  if (origin !== null) hlavicky.set('origin', origin)
  if (kontext.secFetchSite) hlavicky.set('sec-fetch-site', kontext.secFetchSite)

  pozadavek.headers = hlavicky
  pozadavek.cookies.clear()
  if (kontext.jako) pozadavek.cookies.set(SESSION_COOKIE, kontext.jako.token)

  try {
    return await prace()
  } finally {
    pozadavek.headers = new Headers()
    pozadavek.cookies.clear()
  }
}

function adresa(cesta: string): string {
  return new URL(cesta, env.APP_URL).toString()
}

function postJson(kontext: Kontext, telo: unknown): Promise<Response> {
  return vPozadavku(kontext, () =>
    zalozBalicek(
      new Request(adresa('/api/balicky'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(telo),
      }),
    ),
  )
}

function putJson(kontext: Kontext, telo: unknown): Promise<Response> {
  return vPozadavku(kontext, () =>
    ulozBalicek(
      new Request(adresa('/api/balicky'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(telo),
      }),
    ),
  )
}

function postZpravu(kontext: Kontext, packageId: string, soubor: File | null): Promise<Response> {
  const form = new FormData()
  if (soubor) form.set('soubor', soubor)

  return vPozadavku(kontext, () =>
    nahrajZpravu(
      new Request(adresa(`/api/balicky/${packageId}/zprava`), { method: 'POST', body: form }),
      { params: Promise.resolve({ packageId }) },
    ),
  )
}

function getTisk(kontext: Kontext, packageId: string): Promise<Response> {
  return vPozadavku(kontext, () =>
    tiskBalicku(new Request(adresa(`/api/balicky/${packageId}/tisk.pdf`)), {
      params: Promise.resolve({ packageId }),
    }),
  )
}

/**
 * Lékařská zpráva jako soubor z formuláře.
 *
 * Buffer se převádí na Uint8Array: konstruktor File přijímá jen BlobPart
 * s ArrayBuffer, kdežto Buffer má ArrayBufferLike (tedy i SharedArrayBuffer).
 */
async function pdfSoubor(nazev: string, stran = 1): Promise<File> {
  return new File([new Uint8Array(await makePdf(nazev, stran))], `${nazev}.pdf`, {
    type: 'application/pdf',
  })
}

async function json<T = { error?: string }>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Založí balíček stejnou cestou jako prohlížeč a vrátí jeho id. */
async function novyBalicek(kdo: Prihlaseny, problemId?: string): Promise<string> {
  const response = await postJson({ jako: kdo }, problemId ? { problemId } : {})
  expect(response.status).toBe(201)
  return (await json<{ packageId: string }>(response)).packageId
}

function nactiBalicek(kdo: Prihlaseny, packageId: string) {
  return withPractice(kdo.practiceId, (db) => loadPackage(db, packageId))
}

// ---------------------------------------------------------------------------

describe('přihlášení', () => {
  it('bez relace se balíček nezaloží', async () => {
    const response = await postJson({}, {})

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((await json(response)).error).toBeTypeOf('string')
  })

  it('bez relace se balíček ani neuloží', async () => {
    const response = await putJson({}, { packageId: randomUUID(), documents: [] })

    expect(response.status).toBe(401)
    expect((await json(response)).error).toBeTypeOf('string')
  })

  it('zneplatněná relace je stejná jako žádná', async () => {
    const odhlaseny = await prihlas(
      await zalozUzivatele(a.practice.id, 'Odhlášený lékař', ['DOCTOR']),
      a.practice.id,
    )
    await ownerClient.session.updateMany({
      where: { tokenHash: hashToken(odhlaseny.token) },
      data: { revokedAt: new Date() },
    })

    expect((await postJson({ jako: odhlaseny }, {})).status).toBe(401)
  })
})

describe('původ požadavku', () => {
  it('požadavek bez hlavičky Origin se odmítne', async () => {
    // Tohle je celý důvod, proč má aplikace vlastní kontrolu: vestavěná ochrana
    // Next.js porovnává Origin proti hostiteli, ale když hlavička ÚPLNĚ CHYBÍ,
    // požadavek propustí. Ručně sestavený požadavek (curl, skript) ji nemá.
    const response = await postJson({ jako: lekarA, origin: null }, {})

    expect(response.status).toBe(403)
    expect((await json(response)).error).toContain('z této aplikace')
  })

  it('požadavek z cizí domény se odmítne', async () => {
    const response = await postJson({ jako: lekarA, origin: 'https://zla-stranka.example' }, {})

    expect(response.status).toBe(403)
  })

  it('cizí Sec-Fetch-Site se odmítne i se správným Origin', async () => {
    const response = await postJson(
      { jako: lekarA, origin: env.APP_URL, secFetchSite: 'cross-site' },
      {},
    )

    expect(response.status).toBe(403)
  })

  it('kontrola původu se dělá až po kontrole přihlášení', async () => {
    // Nepřihlášenému se nemá prozrazovat, jestli by s jiným původem uspěl.
    const response = await postJson({ origin: null }, {})
    expect(response.status).toBe(401)
  })

  it('požadavek ze stránky aplikace projde', async () => {
    const response = await postJson(
      { jako: lekarA, origin: env.APP_URL, secFetchSite: 'same-origin' },
      { problemId: problemA },
    )

    expect(response.status).toBe(201)
    const { packageId } = await json<{ packageId: string }>(response)
    expect(await nactiBalicek(lekarA, packageId)).toMatchObject({
      status: 'DRAFT',
      problemName: 'Po operaci kolene',
    })
  })
})

describe('uložení dokumentů', () => {
  it('vlastní dokumenty se uloží i s označením pacienta', async () => {
    const packageId = await novyBalicek(lekarA, problemA)

    const response = await putJson(
      { jako: lekarA },
      {
        packageId,
        documents: verzeA.map((id) => ({ kind: 'TEMPLATE', templateVersionId: id })),
        patientLabel: 'Jan Novák',
        note: 'kontrola za týden',
      },
    )

    expect(response.status).toBe(200)
    const view = await json<{
      status: string
      documents: { title: string }[]
      totalPages: number
      patientLabel: string
    }>(response)

    expect(view.status).toBe('READY')
    expect(view.documents.map((d) => d.title)).toEqual(['Pouceni', 'Rezim'])
    expect(view.totalPages).toBe(3)
    expect(view.patientLabel).toBe('Jan Novák')
  })

  it('dokument cizí ordinace se odmítne a balíček zůstane prázdný', async () => {
    const packageId = await novyBalicek(lekarA, problemA)

    const response = await putJson(
      { jako: lekarA },
      { packageId, documents: [{ kind: 'TEMPLATE', templateVersionId: cizoVerze }] },
    )

    expect(response.status).toBe(409)
    expect((await json(response)).error).toBeTypeOf('string')

    // Důležitější než stavový kód: nesmí zůstat půlka práce. Kdyby se mazání
    // starého seznamu dělo před ověřením, balíček by o obsah přišel.
    const view = await nactiBalicek(lekarA, packageId)
    expect(view?.documents).toHaveLength(0)
    expect(view?.status).toBe('DRAFT')
  })

  it('cizí balíček nejde upravit', async () => {
    const ciziBalicek = await novyBalicek(lekarB)

    const response = await putJson({ jako: lekarA }, { packageId: ciziBalicek, documents: [] })

    expect(response.status).toBe(409)
  })

  it('víc než 50 dokumentů se odmítne', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    const prilisDokumentu = Array.from({ length: 51 }, () => ({
      kind: 'TEMPLATE',
      templateVersionId: randomUUID(),
    }))

    const response = await putJson({ jako: lekarA }, { packageId, documents: prilisDokumentu })

    expect(response.status).toBe(400)
    // Přesné znění se schválně netvrdí – prochází přes z.treeifyError(), který
    // hlášky u polí schovává pod properties. Musí to ale být česká věta.
    const { error } = await json(response)
    expect(error).toMatch(/\.$/)

    // Strop platí ještě před prvním dotazem do databáze.
    expect((await nactiBalicek(lekarA, packageId))?.documents).toHaveLength(0)
  })

  it('přesně 50 dokumentů je pořád v mezích', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    const padesat = Array.from({ length: 50 }, () => ({
      kind: 'TEMPLATE',
      templateVersionId: verzeA[0]!,
    }))

    const response = await putJson({ jako: lekarA }, { packageId, documents: padesat })

    expect(response.status).toBe(200)
    expect((await json<{ documents: unknown[] }>(response)).documents).toHaveLength(50)
  })

  it('tělo, které není platný požadavek, se odmítne dřív než cokoli jiného', async () => {
    const response = await putJson({ jako: lekarA }, { packageId: 'neni-uuid', documents: [] })

    expect(response.status).toBe(400)
  })
})

describe('lékařská zpráva', () => {
  it('PDF se přijme a vrátí počet stran', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    const soubor = await pdfSoubor('Zprava', 2)

    const response = await postZpravu({ jako: lekarA }, packageId, soubor)

    expect(response.status).toBe(201)
    const vysledek = await json<{ uploadedFileId: string; pageCount: number }>(response)
    expect(vysledek.pageCount).toBe(2)
    expect(vysledek.uploadedFileId).toMatch(/^[0-9a-f-]{36}$/i)
  }, 30_000)

  it('soubor, který není PDF ani obrázek, se odmítne českou hláškou', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    const soubor = new File(['jen text, žádné PDF'], 'poznamka.txt', { type: 'text/plain' })

    const response = await postZpravu({ jako: lekarA }, packageId, soubor)

    expect(response.status).toBe(422)
    expect((await json(response)).error).toBe(
      'Tohle není PDF. Vyberte prosím soubor ve formátu PDF.',
    )
  })

  it('prázdný soubor se odmítne', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    const soubor = new File([], 'prazdny.pdf', { type: 'application/pdf' })

    const response = await postZpravu({ jako: lekarA }, packageId, soubor)

    expect(response.status).toBe(400)
    expect((await json(response)).error).toBe('Nebyl vybrán žádný soubor.')
  })

  it('chybějící pole se soubory se odmítne', async () => {
    const packageId = await novyBalicek(lekarA, problemA)

    const response = await postZpravu({ jako: lekarA }, packageId, null)

    expect(response.status).toBe(400)
  })

  it('nesmyslné id balíčku se odmítne dřív, než se sáhne do databáze', async () => {
    const response = await postZpravu(
      { jako: lekarA },
      'nic-takoveho',
      await pdfSoubor('Zprava'),
    )

    expect(response.status).toBe(400)
  }, 30_000)

  it('ke cizímu balíčku se zpráva nepřipojí', async () => {
    const ciziBalicek = await novyBalicek(lekarB)
    const soubor = await pdfSoubor('Zprava')

    const response = await postZpravu({ jako: lekarA }, ciziBalicek, soubor)

    expect(response.status).toBe(409)
  }, 30_000)
})

describe('tisk', () => {
  it('cizí balíček se tváří jako neexistující', async () => {
    const ciziBalicek = await novyBalicek(lekarB)
    const priprava = await putJson(
      { jako: lekarB },
      { packageId: ciziBalicek, documents: [{ kind: 'TEMPLATE', templateVersionId: cizoVerze }] },
    )
    expect(priprava.status).toBe(200)
    // Balíček je připravený k tisku – pro svou ordinaci se opravdu vytiskne.
    expect((await getTisk({ jako: lekarB }, ciziBalicek)).status).toBe(200)

    const response = await getTisk({ jako: lekarA }, ciziBalicek)

    // Ne 403: stav 403 by potvrdil, že balíček někde existuje. Cizí a
    // neexistující se musí chovat úplně stejně, včetně těla odpovědi.
    expect(response.status).toBe(404)
    const neexistujici = await getTisk({ jako: lekarA }, randomUUID())
    expect(neexistujici.status).toBe(404)
    expect(await response.text()).toBe(await neexistujici.text())
  }, 30_000)

  it('nepřihlášený dostane taky 404, ne přesměrování na přihlášení', async () => {
    const packageId = await novyBalicek(lekarA, problemA)

    expect((await getTisk({}, packageId)).status).toBe(404)
  })

  it('vlastní balíček se vrátí jako PDF s přesnou délkou těla', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    await putJson(
      { jako: lekarA },
      {
        packageId,
        documents: verzeA.map((id) => ({ kind: 'TEMPLATE', templateVersionId: id })),
      },
    )

    const response = await getTisk({ jako: lekarA }, packageId)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain('inline')
    expect(response.headers.get('cache-control')).toContain('no-store')

    const telo = Buffer.from(await response.arrayBuffer())

    // Menší Content-Length než skutečná délka useká odpověď a prohlížeč
    // dostane poškozené PDF se stavem 200 – tiše, bez jediné chyby.
    expect(response.headers.get('content-length')).toBe(String(telo.byteLength))
    expect(telo.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await inspectPdf(telo)).toEqual({ pageCount: 3 })
  }, 60_000)

  it('prázdný balíček se tisknout nedá', async () => {
    const packageId = await novyBalicek(lekarA, problemA)

    const response = await getTisk({ jako: lekarA }, packageId)

    expect(response.status).toBe(409)
  })

  it('tisk se zapíše do auditu', async () => {
    const packageId = await novyBalicek(lekarA, problemA)
    await putJson(
      { jako: lekarA },
      { packageId, documents: [{ kind: 'TEMPLATE', templateVersionId: verzeA[0]! }] },
    )

    await getTisk({ jako: lekarA }, packageId)

    const zaznamy = await ownerClient.auditLog.findMany({
      where: { practiceId: a.practice.id, packageId, action: 'PACKAGE_PRINTED' },
    })
    expect(zaznamy).toHaveLength(1)
  }, 60_000)
})

describe('role', () => {
  it('sestra smí balíček připravit', async () => {
    // Do knihovny šablon sestra nesmí, ale příprava balíčku je její práce.
    const packageId = await novyBalicek(sestraA, problemA)

    const response = await putJson(
      { jako: sestraA },
      {
        packageId,
        documents: [{ kind: 'TEMPLATE', templateVersionId: verzeA[0]! }],
        patientLabel: 'Marie Svobodová',
      },
    )

    expect(response.status).toBe(200)
    expect((await json<{ status: string }>(response)).status).toBe('READY')
  })

  it('sestra smí k balíčku nahrát zprávu i ho vytisknout', async () => {
    const packageId = await novyBalicek(sestraA, problemA)
    const soubor = await pdfSoubor('Zprava')

    const nahrani = await postZpravu({ jako: sestraA }, packageId, soubor)
    expect(nahrani.status).toBe(201)
    const { uploadedFileId } = await json<{ uploadedFileId: string }>(nahrani)

    await putJson(
      { jako: sestraA },
      { packageId, documents: [{ kind: 'UPLOAD', uploadedFileId }] },
    )

    const tisk = await getTisk({ jako: sestraA }, packageId)
    expect(tisk.status).toBe(200)
    expect(Buffer.from(await tisk.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 60_000)

  it('balíček sestry patří ordinaci, ne jí – lékař ho vidí taky', async () => {
    const packageId = await novyBalicek(sestraA, problemA)

    const response = await putJson(
      { jako: lekarA },
      { packageId, documents: [{ kind: 'TEMPLATE', templateVersionId: verzeA[1]! }] },
    )

    expect(response.status).toBe(200)
  })
})
