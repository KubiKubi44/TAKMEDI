import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import type { PackageStatus, TokenChannel } from '@/generated/prisma/enums'
import { Hlavicka } from '@/components/hlavicka'
import { Alert, Card } from '@/components/ui'
import { isPracticeAdmin, requireRole } from '@/lib/auth'
import { decryptOptional } from '@/lib/crypto'
import { withPractice } from '@/lib/db'
import { listAudit } from '@/lib/history'

/**
 * Detail jednoho předání: co pacient dostal a co se s tím dělo.
 *
 * Oprávnění se ověřuje tady, ne v layoutu – layout se při navigaci mezi
 * stránkami znovu nevykresluje a nerozhoduje o tom, jestli se zbytek cesty
 * spočítá. Bezpečnostní hranicí je stránka a Server Action.
 *
 * Sestra sem nesmí. V tabulce oprávnění (architektura, kapitola 6) má čtení
 * auditního deníku jen lékař a admin ordinace, a časová osa na téhle stránce
 * je auditní deník – včetně IP adresy a prohlížeče pacienta.
 */

export const metadata: Metadata = {
  title: 'Detail předání – MedPředání',
}

/** Nesmysl v adrese má skončit stránkou 404, ne chybou z databáze. */
const TVAR_ID = /^[0-9a-f-]{36}$/i

/**
 * Kolik událostí se vypíše. Jeden balíček jich má typicky jednotky; strop je
 * tu pro případ, kdy si pacient otevře odkaz a stáhne dokumenty stokrát.
 */
const LIMIT_UDALOSTI = 200

/**
 * Data se formátují na SERVERU s pevnou časovou zónou. Server běží v UTC
 * a prohlížeč v zóně uživatele – kdyby si čas poskládal každý sám, React by
 * po hydrataci hlásil rozdíl a údaj by po načtení stránky poskočil.
 */
const FORMAT_DATUM = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/Prague',
})

const FORMAT_DATUM_CAS = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Prague',
})

/** V auditu se sekundy hodí: několik událostí spadne do jedné minuty. */
const FORMAT_UDALOSTI = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Prague',
})

/**
 * Názvy auditních akcí česky.
 *
 * Deník čte lékař, ne programátor. Záměrně to není Record<AuditAction, string>:
 * akce, kterou tenhle výpis nezná, se musí vypsat tak, jak je uložená –
 * radši syrově než vůbec.
 */
const NAZVY_AKCI: Record<string, string> = {
  PACKAGE_CREATED: 'Balíček založen',
  PACKAGE_UPDATED: 'Balíček upraven',
  HANDOFF_ACTIVATED: 'Spuštěno předání přes čip',
  HANDOFF_CLAIMED: 'Pacient zadal kód a převzal dokumenty',
  HANDOFF_CODE_FAILED: 'Špatně zadaný kód',
  HANDOFF_LOCKED: 'Zamčeno po opakovaných pokusech',
  HANDOFF_CANCELLED: 'Předání přes čip zrušeno',
  TOKEN_ISSUED: 'Vystaven odkaz pro pacienta',
  TOKEN_REVOKED: 'Odkaz zneplatněn',
  PATIENT_PAGE_VIEWED: 'Pacient si otevřel dokumenty',
  PATIENT_VERIFY_FAILED: 'Špatně zadaný PIN nebo datum narození',
  DOCUMENT_DOWNLOADED: 'Staženo',
  PACKAGE_PRINTED: 'Vytištěno',
  EMAIL_SENT: 'Odesláno e-mailem',
  EMAIL_FAILED: 'E-mail se nepodařilo odeslat',
  FILES_PURGED: 'Dokumenty smazány po vypršení platnosti',
}

const NAZVY_STAVU: Record<PackageStatus, string> = {
  DRAFT: 'Rozpracovaný',
  READY: 'Připravený',
  HANDED: 'Předaný',
  EXPIRED: 'Po platnosti',
  REVOKED: 'Zneplatněný',
}

/** Stejné názvy jako ve výpisu historie – obsluha přechází mezi obrazovkami. */
const NAZVY_KANALU: Record<TokenChannel, string> = {
  NFC: 'Čip',
  EMAIL: 'E-mail',
  // Odkaz vydaný ručně, bez čipu a bez e-mailu. Tisk žádný odkaz nevydává.
  MANUAL: 'Odkaz',
}

/** Kdo událost způsobil, když u ní není jméno. */
const NAZVY_AKTERU: Record<string, string> = {
  USER: 'Personál ordinace',
  PATIENT: 'Pacient',
  SYSTEM: 'Systém',
}

/**
 * Doplňující údaje z metadat.
 *
 * Vypisují se jen klíče, které něco říkají obsluze. Identifikátory záznamů
 * v databázi se schovají – lékaři nepomůžou a jen by přebily to podstatné.
 */
const POPIS_KLICE: Record<string, string> = {
  akce: 'Co se stalo',
  co: 'Co',
  kanal: 'Kanál',
  kde: 'Kde',
  nazev: 'Dokument',
  pageCount: 'Stran',
  platnostDni: 'Platnost ve dnech',
  platnostSekund: 'Platnost v sekundách',
  pocetDokumentu: 'Dokumentů',
  pokus: 'Pokus číslo',
  souboru: 'Smazáno souborů',
  stran: 'Stran',
  version: 'Verze',
  zneplatneno: 'Zneplatněno odkazů',
}

/** Hodnoty, které jsou v metadatech uložené jako kód. */
const POPIS_HODNOTY: Record<string, string> = {
  EMAIL: 'e-mail',
  NFC: 'čip',
  MANUAL: 'ručně vydaný odkaz',
  knihovna: 'knihovna',
  pacient: 'stránka pacienta',
  'vse-v-jednom': 'všechny dokumenty v jednom PDF',
  nahrani_zpravy: 'nahrání lékařské zprávy',
}

function hodnota(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'ano' : 'ne'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return POPIS_HODNOTY[value] ?? value
  return JSON.stringify(value)
}

function popisMetadat(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return []

  const radky: string[] = []
  for (const [klic, value] of Object.entries(metadata)) {
    const popisek = POPIS_KLICE[klic]
    if (!popisek || value === null || value === '') continue
    radky.push(`${popisek}: ${hodnota(value)}`)
  }
  return radky
}

function sklonuj(pocet: number, jeden: string, dva: string, pet: string): string {
  if (pocet === 1) return `${pocet} ${jeden}`
  if (pocet >= 2 && pocet <= 4) return `${pocet} ${dva}`
  return `${pocet} ${pet}`
}

export default async function DetailPredaniPage({
  params,
}: {
  params: Promise<{ packageId: string }>
}) {
  const session = await requireRole('DOCTOR', 'PRACTICE_ADMIN')
  const { packageId } = await params

  if (!TVAR_ID.test(packageId)) notFound()

  const practiceId = session.user.practiceId

  const data = await withPractice(practiceId, async (db) => {
    // Sloupce jsou vypsané ručně: do stránky se tak nemůže dostat nic, co sem
    // nepatří, ani když se model později rozroste.
    const balicek = await db.package.findUnique({
      where: { id: packageId },
      select: {
        id: true,
        createdAt: true,
        status: true,
        expiresAt: true,
        purgedAt: true,
        patientLabelEnc: true,
        noteEnc: true,
        problem: { select: { name: true, icd10: true } },
        createdBy: { select: { name: true } },
        documents: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            title: true,
            kind: true,
            templateVersion: { select: { version: true, pageCount: true } },
            uploadedFile: { select: { pageCount: true, deletedAt: true } },
          },
        },
        tokens: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            channel: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            verificationType: true,
            verifiedAt: true,
            accessCount: true,
            lastAccessedAt: true,
          },
        },
      },
    })

    if (!balicek) return null

    const audit = await listAudit(db, { packageId, limit: LIMIT_UDALOSTI })

    // listAudit() prohlížeč nevrací – v přehledovém výpisu deníku by byl jen
    // šum. Tady je potřeba: u pacientských událostí se podle GDPR dokládá,
    // z jakého zařízení k dokumentům někdo přistoupil. Bere se stejné okno
    // záznamů jako výše, tedy od nejnovějšího.
    const prohlizece = await db.auditLog.findMany({
      where: { packageId, actorType: 'PATIENT' },
      orderBy: { id: 'desc' },
      take: LIMIT_UDALOSTI,
      select: { id: true, userAgent: true },
    })

    // Počítá se dotazem, ne z vypsaných událostí: u balíčku s dlouhou historií
    // by se tisk mohl stát mimo okno LIMIT_UDALOSTI a v přehledu by chyběl.
    const tisku = await db.auditLog.count({ where: { packageId, action: 'PACKAGE_PRINTED' } })

    return { balicek, audit, prohlizece, tisku }
  })

  // Cizí balíček politika RLS nevrátí, takže null znamená „neexistuje, nebo
  // není náš". Obojí vypadá navenek stejně – jinak by šlo zjistit, kolik
  // balíčků má jiná ordinace.
  if (!data) notFound()

  const { balicek, audit, prohlizece, tisku } = data
  const ted = new Date()

  const oznaceniPacienta = decryptOptional(balicek.patientLabelEnc)
  const poznamka = decryptOptional(balicek.noteEnc)

  const kanaly = [...new Set(balicek.tokens.map((token) => token.channel))]

  const prohlizecPodleId = new Map(prohlizece.map((radek) => [radek.id.toString(), radek.userAgent]))

  // Deník se čte od nejnovějšího, ale příběh jednoho balíčku se čte od začátku:
  // založen, předán, otevřen, stažen. Pořadí se proto otáčí.
  const udalosti = [...audit.items].reverse()

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <nav aria-label="Drobečková navigace">
          <Link
            href="/historie"
            className="inline-flex min-h-12 items-center font-medium text-text-tlumeny hover:text-hlavni"
          >
            <span aria-hidden="true" className="mr-2">
              &larr;
            </span>
            Zpět na historii
          </Link>
        </nav>

        <header>
          <p className="text-sm text-text-tlumeny">
            {FORMAT_DATUM_CAS.format(balicek.createdAt)} · {balicek.createdBy.name}
          </p>
          <h1 className="text-2xl font-semibold">
            {oznaceniPacienta ?? 'Předání bez označení pacienta'}
          </h1>
          <p className="mt-1 text-text-tlumeny">
            {balicek.problem ? balicek.problem.name : 'Bez zvoleného problému'}
            {balicek.problem?.icd10 ? ` (${balicek.problem.icd10})` : ''}
          </p>
        </header>

        {balicek.purgedAt ? (
          <Alert tone="info">
            Platnost tohohle předání vypršela a dokumenty se{' '}
            {FORMAT_DATUM.format(balicek.purgedAt)} smazaly. Zůstalo jen to, co je na téhle
            stránce: kdy, kdo, jaký problém, co bylo v balíčku a co se s ním dělo. Označení
            pacienta a poznámka se mažou spolu s dokumenty.
          </Alert>
        ) : null}

        <section aria-labelledby="nadpis-prehled" className="space-y-4">
          <h2 id="nadpis-prehled" className="text-xl font-semibold">
            Přehled
          </h2>

          <Card>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Udaj popisek="Kdy">{FORMAT_DATUM_CAS.format(balicek.createdAt)}</Udaj>
              <Udaj popisek="Kdo připravil">{balicek.createdBy.name}</Udaj>
              <Udaj popisek="Problém">
                {balicek.problem?.name ?? <span className="text-text-tlumeny">Nezvolený</span>}
              </Udaj>
              <Udaj popisek="Označení pacienta">
                {oznaceniPacienta ?? <span className="text-text-tlumeny">Neuvedené</span>}
              </Udaj>
              <Udaj popisek="Stav">{NAZVY_STAVU[balicek.status]}</Udaj>
              <Udaj popisek="Platnost odkazu">
                {balicek.expiresAt === null ? (
                  <span className="text-text-tlumeny">Balíček se zatím nepředal</span>
                ) : balicek.expiresAt > ted ? (
                  `do ${FORMAT_DATUM.format(balicek.expiresAt)}`
                ) : (
                  `vypršela ${FORMAT_DATUM.format(balicek.expiresAt)}`
                )}
              </Udaj>
              <Udaj popisek="Předáno kanály">
                {kanaly.length === 0 ? (
                  <span className="text-text-tlumeny">Zatím žádným</span>
                ) : (
                  kanaly.map((kanal) => NAZVY_KANALU[kanal]).join(', ')
                )}
              </Udaj>
              <Udaj popisek="Tisk">
                {tisku === 0 ? (
                  <span className="text-text-tlumeny">Netištěno</span>
                ) : (
                  sklonuj(tisku, 'tisk', 'tisky', 'tisků')
                )}
              </Udaj>
              {poznamka ? (
                <div className="sm:col-span-2">
                  <dt className="text-sm text-text-tlumeny">Interní poznámka</dt>
                  <dd className="mt-0.5 whitespace-pre-line font-medium">{poznamka}</dd>
                </div>
              ) : null}
            </dl>
          </Card>
        </section>

        <section aria-labelledby="nadpis-dokumenty" className="space-y-4">
          <h2 id="nadpis-dokumenty" className="text-xl font-semibold">
            Dokumenty
          </h2>

          {balicek.documents.length === 0 ? (
            <p className="rounded-2xl border border-obrys bg-plocha px-5 py-6 text-text-tlumeny">
              Balíček neobsahuje žádný dokument.
            </p>
          ) : (
            <ol className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys bg-plocha shadow-sm">
              {balicek.documents.map((dokument, index) => (
                <li key={dokument.id} className="px-5 py-4">
                  <p className="font-medium">
                    <span className="mr-2 text-text-tlumeny tabular-nums">{index + 1}.</span>
                    {dokument.title}
                  </p>
                  <p className="mt-1 text-sm text-text-tlumeny">{popisDokumentu(dokument)}</p>
                </li>
              ))}
            </ol>
          )}

          <p className="text-sm text-text-tlumeny">
            Názvy i verze jsou zmrazené k okamžiku předání. Pozdější úprava letáku v knihovně
            tenhle výpis nezmění – pacient dostal tohle.
          </p>
        </section>

        <section aria-labelledby="nadpis-odkazy" className="space-y-4">
          <h2 id="nadpis-odkazy" className="text-xl font-semibold">
            Odkazy pro pacienta
          </h2>

          {balicek.tokens.length === 0 ? (
            <p className="rounded-2xl border border-obrys bg-plocha px-5 py-6 text-text-tlumeny">
              Pacientovi se zatím nevydal žádný odkaz. Balíček mohl odejít jen vytištěný.
            </p>
          ) : (
            <ul className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys bg-plocha shadow-sm">
              {balicek.tokens.map((token) => (
                <li key={token.id} className="px-5 py-4">
                  <p className="font-medium">
                    {NAZVY_KANALU[token.channel]}
                    <span className="ml-2 font-normal text-text-tlumeny">
                      · vydáno {FORMAT_DATUM_CAS.format(token.createdAt)}
                    </span>
                  </p>
                  <p className="mt-1 text-sm">
                    <span
                      className={
                        token.revokedAt !== null || token.expiresAt <= ted
                          ? 'text-text-tlumeny'
                          : 'text-uspech'
                      }
                    >
                      {stavOdkazu(token, ted)}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-text-tlumeny">{popisOtevreni(token)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="nadpis-audit" className="space-y-4">
          <h2 id="nadpis-audit" className="text-xl font-semibold">
            Co se s balíčkem dělo
          </h2>

          <p className="max-w-2xl text-text-tlumeny">
            Záznamy vznikají samy při každé akci a nejdou změnit ani smazat. U kroků pacienta je
            vidět i IP adresa a prohlížeč – podle nich se dá doložit, kdo se k dokumentům dostal.
          </p>

          {udalosti.length === 0 ? (
            <p className="rounded-2xl border border-obrys bg-plocha px-5 py-6 text-text-tlumeny">
              K tomuhle balíčku zatím není žádný záznam.
            </p>
          ) : (
            <ol className="space-y-0 border-l-2 border-obrys pl-5">
              {udalosti.map((zaznam) => {
                const detaily = popisMetadat(zaznam.metadata)
                const jePacient = zaznam.actorType === 'PATIENT'
                const prohlizec = prohlizecPodleId.get(zaznam.id) ?? null

                return (
                  <li key={zaznam.id} className="relative py-4">
                    {/* Puntík na ose. Je dekorace, takže se před odečítačkou schová. */}
                    <span
                      aria-hidden="true"
                      className="absolute -left-[1.4rem] top-6 h-2.5 w-2.5 rounded-full bg-obrys"
                    />
                    <p className="text-sm text-text-tlumeny">
                      <time dateTime={zaznam.createdAt.toISOString()}>
                        {FORMAT_UDALOSTI.format(zaznam.createdAt)}
                      </time>
                    </p>
                    <p className="font-medium">
                      {NAZVY_AKCI[zaznam.action] ?? zaznam.action}
                    </p>
                    <p className="text-sm text-text-tlumeny">
                      {zaznam.actorName ?? NAZVY_AKTERU[zaznam.actorType] ?? zaznam.actorType}
                    </p>
                    {detaily.length > 0 ? (
                      <p className="mt-1 text-sm text-text-tlumeny">{detaily.join(' · ')}</p>
                    ) : null}
                    {jePacient ? (
                      <p className="mt-1 break-all text-xs text-text-tlumeny">
                        IP {zaznam.ip ?? 'neznámá'}
                        {prohlizec ? ` · ${prohlizec}` : ' · prohlížeč neznámý'}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )}

          {audit.total > udalosti.length ? (
            <p className="text-sm text-text-tlumeny">
              Vypsáno {sklonuj(udalosti.length, 'záznam', 'záznamy', 'záznamů')} z celkových{' '}
              {audit.total}. Zbytek je v auditním deníku ordinace.
            </p>
          ) : null}

          <p className="text-sm">
            <Link href="/nastaveni/audit" className="underline underline-offset-4 hover:text-hlavni">
              Celý auditní deník ordinace
            </Link>
          </p>
        </section>
      </main>
    </div>
  )
}

function Udaj({ popisek, children }: { popisek: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-text-tlumeny">{popisek}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  )
}

type DokumentRadek = {
  kind: 'TEMPLATE' | 'UPLOAD'
  templateVersion: { version: number; pageCount: number } | null
  uploadedFile: { pageCount: number; deletedAt: Date | null } | null
}

/** Jednořádkový popis: „z knihovny · verze 3 · 2 strany". */
function popisDokumentu(dokument: DokumentRadek): string {
  const casti: string[] = []

  if (dokument.kind === 'TEMPLATE') {
    casti.push('z knihovny')
    if (dokument.templateVersion) {
      casti.push(`verze ${dokument.templateVersion.version}`)
      casti.push(sklonuj(dokument.templateVersion.pageCount, 'strana', 'strany', 'stran'))
    }
  } else {
    casti.push('nahraný soubor')
    if (dokument.uploadedFile) {
      casti.push(sklonuj(dokument.uploadedFile.pageCount, 'strana', 'strany', 'stran'))
      if (dokument.uploadedFile.deletedAt) casti.push('obsah už je smazaný')
    }
  }

  return casti.join(' · ')
}

type OdkazRadek = {
  expiresAt: Date
  revokedAt: Date | null
  verificationType: 'NONE' | 'PIN' | 'DOB'
  verifiedAt: Date | null
  accessCount: number
  lastAccessedAt: Date | null
}

function stavOdkazu(token: OdkazRadek, ted: Date): string {
  if (token.revokedAt !== null) {
    return `Zneplatněný ${FORMAT_DATUM_CAS.format(token.revokedAt)}`
  }
  if (token.expiresAt <= ted) {
    return `Po platnosti od ${FORMAT_DATUM_CAS.format(token.expiresAt)}`
  }
  return `Platný do ${FORMAT_DATUM.format(token.expiresAt)}`
}

function popisOtevreni(token: OdkazRadek): string {
  const casti: string[] = []

  if (token.accessCount === 0) {
    casti.push('Pacient odkaz zatím neotevřel')
  } else {
    casti.push(`Otevřeno ${token.accessCount}×`)
    if (token.lastAccessedAt) {
      casti.push(`naposledy ${FORMAT_DATUM_CAS.format(token.lastAccessedAt)}`)
    }
  }

  if (token.verificationType === 'PIN') {
    casti.push(token.verifiedAt ? 'PIN zadaný správně' : 'čeká na zadání PINu')
  }
  if (token.verificationType === 'DOB') {
    casti.push(token.verifiedAt ? 'datum narození ověřené' : 'čeká na datum narození')
  }

  return casti.join(' · ')
}
