import type { Metadata } from 'next'
import Link from 'next/link'

import { Hlavicka } from '@/components/hlavicka'
import { Alert, Card } from '@/components/ui'
import { isPracticeAdmin, requireRole } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { listAudit, verifyAuditChain } from '@/lib/history'

/**
 * Auditní deník ordinace.
 *
 * Oprávnění se ověřuje tady, ne v layoutu – layout se při navigaci mezi
 * stránkami znovu nevykresluje a nerozhoduje o tom, jestli se zbytek cesty
 * spočítá. Bezpečnostní hranicí je stránka a Server Action.
 *
 * Deník čte lékař a admin ordinace, sestra ne (architektura, kapitola 6).
 * Stránka je proto volnější než zbytek /nastaveni, kam smí jen admin.
 */

export const metadata: Metadata = {
  title: 'Auditní deník – MedPředání',
}

/** Kolik záznamů je na jedné straně. */
const NA_STRANU = 100

/**
 * Odkaz, který vypadá jako tlačítko.
 *
 * Stránkování je navigace, ne akce – musí to být poctivé <a>, aby fungovalo
 * otevření na nové kartě i prostřední tlačítko myši. Button z ui.tsx
 * vykresluje <button>, proto se třídy opisují.
 */
const ODKAZ_JAKO_TLACITKO =
  'inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-obrys bg-plocha px-5 text-base font-semibold text-text transition-colors hover:border-hlavni'

/**
 * Časy se formátují na SERVERU s pevnou časovou zónou. Server běží v UTC
 * a prohlížeč v zóně uživatele – kdyby si čas poskládal každý sám, React by
 * po hydrataci hlásil rozdíl a údaj by po načtení stránky poskočil.
 *
 * Sekundy tu nejsou zbytečnost: několik událostí spadne do jedné minuty
 * a na jejich pořadí může záležet.
 */
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

const FORMAT_CISLA = new Intl.NumberFormat('cs-CZ')

/**
 * Názvy auditních akcí česky.
 *
 * Deník čte lékař, ne programátor. Záměrně to není Record<AuditAction, string>:
 * akce, kterou tenhle výpis nezná, se musí vypsat tak, jak je uložená –
 * radši syrově než vůbec.
 */
const NAZVY_AKCI: Record<string, string> = {
  LOGIN_SUCCESS: 'Přihlášení',
  LOGIN_FAILED: 'Neúspěšné přihlášení',
  TOTP_FAILED: 'Špatný ověřovací kód',
  TOTP_ENROLLED: 'Nastaveno dvoufázové přihlášení',
  LOGOUT: 'Odhlášení',
  SESSION_EXPIRED: 'Vypršelo přihlášení',
  USER_CREATED: 'Založen uživatel',
  USER_UPDATED: 'Upraven uživatel',
  USER_DISABLED: 'Uživatel zablokován',
  SETTINGS_CHANGED: 'Změna nastavení',
  NFC_TAG_CREATED: 'Vytvořen NFC čip',
  NFC_TAG_REVOKED: 'NFC čip odvolán',
  TEMPLATE_UPLOADED: 'Nahrán dokument',
  TEMPLATE_ARCHIVED: 'Dokument archivován',
  PROBLEM_CREATED: 'Založen problém',
  PROBLEM_UPDATED: 'Úprava v knihovně',
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
  archivovano: 'Archivováno',
  co: 'Co',
  duvod: 'Důvod',
  jmeno: 'Koho se týká',
  kanal: 'Kanál',
  kde: 'Kde',
  label: 'Označení čipu',
  na: 'Nově',
  nazev: 'Dokument',
  novyStav: 'Nový stav',
  pageCount: 'Stran',
  platnostDni: 'Platnost ve dnech',
  platnostSekund: 'Platnost v sekundách',
  pocetDokumentu: 'Dokumentů',
  pocetNeuspechu: 'Neúspěšných pokusů',
  pokus: 'Pokus číslo',
  role: 'Role',
  smer: 'Směr',
  souboru: 'Smazáno souborů',
  stran: 'Stran',
  version: 'Verze',
  z: 'Původně',
  zamceno: 'Účet zamčen',
  zneplatneno: 'Zneplatněno odkazů',
}

/** Názvy nastavení ordinace, jak je zapisuje SETTINGS_CHANGED. */
const POPIS_NASTAVENI: Record<string, string> = {
  name: 'Název ordinace',
  addressLine: 'Adresa',
  linkTtlDays: 'Platnost odkazu ve dnech',
  handoffTtlSeconds: 'Platnost kódu v sekundách',
  sessionIdleMinutes: 'Odhlášení po nečinnosti v minutách',
}

/** Hodnoty, které jsou v metadatech uložené jako kód. */
const POPIS_HODNOTY: Record<string, string> = {
  EMAIL: 'e-mail',
  NFC: 'čip',
  MANUAL: 'ručně vydaný odkaz',
  DOCTOR: 'lékař',
  NURSE: 'sestra',
  PRACTICE_ADMIN: 'admin ordinace',
  ACTIVE: 'aktivní',
  DISABLED: 'zablokovaný',
  knihovna: 'knihovna',
  pacient: 'stránka pacienta',
  'vse-v-jednom': 'všechny dokumenty v jednom PDF',
  nahrani_zpravy: 'nahrání lékařské zprávy',
  prejmenovani: 'přejmenování',
  presun: 'přesun',
  neznamy_email: 'neznámý e-mail',
  spatne_heslo: 'špatné heslo',
  ucet_zamceny: 'účet byl zamčený',
  prekrocena_cetnost: 'překročený počet pokusů',
}

function hodnota(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'ano' : 'ne'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return POPIS_HODNOTY[value] ?? value
  if (Array.isArray(value)) return value.map(hodnota).join(', ')
  return JSON.stringify(value)
}

/** Dvojice „z / na" u změny nastavení. */
function jeZmena(value: unknown): value is { z: unknown; na: unknown } {
  return typeof value === 'object' && value !== null && 'z' in value && 'na' in value
}

function popisMetadat(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return []

  const radky: string[] = []

  for (const [klic, value] of Object.entries(metadata)) {
    // Změna nastavení nese původní i novou hodnotu u každé položky zvlášť.
    // Bez rozbalení by v deníku stálo jen „zmeny: [object Object]".
    if (klic === 'zmeny' && typeof value === 'object' && value !== null) {
      for (const [pole, zmena] of Object.entries(value)) {
        if (!jeZmena(zmena)) continue
        radky.push(
          `${POPIS_NASTAVENI[pole] ?? pole}: ${hodnota(zmena.z)} → ${hodnota(zmena.na)}`,
        )
      }
      continue
    }

    const popisek = POPIS_KLICE[klic]
    if (!popisek || value === null || value === '') continue
    radky.push(`${popisek}: ${hodnota(value)}`)
  }

  return radky
}

function sklonuj(pocet: number, jeden: string, dva: string, pet: string): string {
  const cislo = FORMAT_CISLA.format(pocet)
  if (pocet === 1) return `${cislo} ${jeden}`
  if (pocet >= 2 && pocet <= 4) return `${cislo} ${dva}`
  return `${cislo} ${pet}`
}

/** Číslo strany z adresy. Nesmysl v parametru vede na první stranu, ne na chybu. */
function cisloStrany(raw: string | string[] | undefined): number {
  const prvni = Array.isArray(raw) ? raw[0] : raw
  const cislo = Number(prvni)
  if (!Number.isInteger(cislo) || cislo < 1) return 1
  return Math.min(cislo, 10_000)
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ strana?: string | string[] }>
}) {
  const session = await requireRole('DOCTOR', 'PRACTICE_ADMIN')
  const practiceId = session.user.practiceId
  const jeAdmin = isPracticeAdmin(session.user)

  const strana = cisloStrany((await searchParams).strana)

  const { denik, retez } = await withPractice(practiceId, async (db) => ({
    denik: await listAudit(db, { limit: NA_STRANU, offset: (strana - 1) * NA_STRANU }),
    retez: await verifyAuditChain(db, practiceId),
  }))

  const stran = Math.max(1, Math.ceil(denik.total / NA_STRANU))
  const zaPosledniStranou = denik.items.length === 0 && denik.total > 0

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={jeAdmin}
      />

      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <nav aria-label="Drobečková navigace">
          {/* Lékař bez práv admina se do /nastaveni nedostane – odkaz by ho
              dovedl na stránku 403. Vrací se proto na přípravu balíčku. */}
          <Link
            href={jeAdmin ? '/nastaveni' : '/'}
            className="inline-flex min-h-12 items-center font-medium text-text-tlumeny hover:text-hlavni"
          >
            <span aria-hidden="true" className="mr-2">
              &larr;
            </span>
            {jeAdmin ? 'Zpět na nastavení' : 'Zpět na přípravu'}
          </Link>
        </nav>

        <header>
          <p className="text-sm text-text-tlumeny">{session.practice.name}</p>
          <h1 className="text-2xl font-semibold">Auditní deník</h1>
          <p className="mt-1 max-w-2xl text-text-tlumeny">
            Záznam o všem, co se v ordinaci stalo: přihlášení, práce s knihovnou, předání
            balíčků i kroky pacientů. Zapisuje se sám a čte ho lékař a admin ordinace.
          </p>
        </header>

        {retez.ok ? (
          <Alert tone="uspech">
            Deník je neporušený, zkontrolováno {sklonuj(retez.zkontrolovano, 'záznam', 'záznamy', 'záznamů')}.
          </Alert>
        ) : (
          <Alert tone="chyba">
            Deník je porušený: {retez.prvniChyba ?? 'řetěz záznamů nenavazuje'}. Aplikace sama
            záznam změnit ani smazat neumí, takže tohle znamená zásah do databáze mimo ni.
            Ozvěte se prosím správci systému a do vyjasnění berte obsah deníku jako nedůvěryhodný.
          </Alert>
        )}

        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">Proč se deníku dá věřit</h2>
          <p className="max-w-2xl text-text-tlumeny">
            Do deníku jde jen přidávat. Aplikace má na tabulku právo zapsat a číst, ne měnit
            nebo mazat – a databáze to navíc hlídá sama, takže přepsat záznam neumí ani
            aplikace, ani nikdo, kdo se přihlásí do ordinace.
          </p>
          <p className="max-w-2xl text-text-tlumeny">
            Každý záznam je navíc otiskem spojený s tím předchozím. Kdyby někdo sáhl do
            databáze zvenčí a řádek změnil nebo vytrhl, řetěz se rozpadne a kontrola nahoře
            na téhle stránce ukáže, kde k tomu došlo.
          </p>
        </Card>

        <section aria-labelledby="nadpis-zaznamy" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 id="nadpis-zaznamy" className="text-xl font-semibold">
              Záznamy
            </h2>
            <p className="text-sm text-text-tlumeny">
              Celkem {sklonuj(denik.total, 'záznam', 'záznamy', 'záznamů')}
              {stran > 1 ? ` · strana ${strana} z ${stran}` : ''}
            </p>
          </div>

          {zaPosledniStranou ? (
            <Alert tone="info">
              Na téhle straně už žádné záznamy nejsou.{' '}
              <Link href="/nastaveni/audit" className="underline underline-offset-4">
                Zpět na první stranu
              </Link>
              .
            </Alert>
          ) : denik.items.length === 0 ? (
            <p className="rounded-2xl border border-obrys bg-plocha px-5 py-6 text-text-tlumeny">
              Deník je zatím prázdný. První záznamy přibudou hned, jak se někdo přihlásí nebo
              připraví balíček.
            </p>
          ) : (
            <ul className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys bg-plocha shadow-sm">
              {denik.items.map((zaznam) => {
                const detaily = popisMetadat(zaznam.metadata)

                return (
                  <li key={zaznam.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <p className="font-medium">{NAZVY_AKCI[zaznam.action] ?? zaznam.action}</p>
                      <p className="text-sm tabular-nums text-text-tlumeny">
                        <time dateTime={zaznam.createdAt.toISOString()}>
                          {FORMAT_UDALOSTI.format(zaznam.createdAt)}
                        </time>
                      </p>
                    </div>

                    <p className="mt-1 text-sm text-text-tlumeny">
                      {zaznam.actorName ?? NAZVY_AKTERU[zaznam.actorType] ?? zaznam.actorType}
                      {zaznam.actorType === 'PATIENT' && zaznam.ip ? ` · IP ${zaznam.ip}` : ''}
                    </p>

                    {detaily.length > 0 ? (
                      <p className="mt-1 text-sm text-text-tlumeny">{detaily.join(' · ')}</p>
                    ) : null}

                    {zaznam.packageId ? (
                      <p className="mt-1 text-sm">
                        <Link
                          href={`/historie/${zaznam.packageId}`}
                          className="underline underline-offset-4 hover:text-hlavni"
                        >
                          Otevřít předání
                        </Link>
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          {stran > 1 ? (
            <nav aria-label="Stránkování deníku" className="flex flex-wrap items-center gap-3">
              {strana > 1 ? (
                // Min() kvůli číslu strany vypsanému ručně do adresy: odtud
                // se jedním kliknutím vrací na poslední stranu se záznamy.
                <Link
                  href={odkazNaStranu(Math.min(strana - 1, stran))}
                  className={ODKAZ_JAKO_TLACITKO}
                >
                  <span aria-hidden="true" className="mr-2">
                    &larr;
                  </span>
                  Novější
                </Link>
              ) : null}
              {strana < stran ? (
                <Link href={odkazNaStranu(strana + 1)} className={ODKAZ_JAKO_TLACITKO}>
                  Starší
                  <span aria-hidden="true" className="ml-2">
                    &rarr;
                  </span>
                </Link>
              ) : null}
              <span className="text-sm text-text-tlumeny">
                Strana {strana} z {stran}
              </span>
            </nav>
          ) : null}
        </section>
      </main>
    </div>
  )
}

function odkazNaStranu(strana: number): string {
  return strana <= 1 ? '/nastaveni/audit' : `/nastaveni/audit?strana=${strana}`
}
