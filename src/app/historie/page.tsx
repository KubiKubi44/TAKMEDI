import type { Metadata } from 'next'
import Link from 'next/link'
import { Fragment } from 'react'

import { Hlavicka } from '@/components/hlavicka'
import { Button, Card } from '@/components/ui'
import type { TokenChannel } from '@/generated/prisma/enums'
import { hasRole, isPracticeAdmin, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { listHistory, type HistoryItem } from '@/lib/history'
import { zneplatnitOdkaz } from './akce'
import { Filtr, type Volba } from './filtr'

/**
 * Historie předaných balíčků.
 *
 * Vidí ji celá ordinace včetně sestry – předání je její každodenní práce
 * a dohledat, co který pacient dostal, musí umět stejně jako lékař.
 * Oprávnění se ověřuje tady, ne v layoutu: layout se při navigaci znovu
 * nevykresluje a nerozhoduje o tom, jestli se zbytek cesty spočítá.
 * Bezpečnostní hranicí je stránka a Server Action.
 *
 * Samotné dokumenty tady nejsou. Historie je záznam o předání – kdy, komu,
 * co a jakou cestou – a po vypršení platnosti z něj osobní údaje mizí.
 */

export const metadata: Metadata = {
  title: 'Historie – MedPředání',
}

/** Kolik předání se vejde na stránku. Víc už se v ordinaci neprochází. */
const LIMIT = 25

/**
 * Strop na číslo strany.
 *
 * Z adresy se dá napsat cokoli a offset v řádu miliard by databázi nutil
 * procházet celou tabulku pro prázdný výsledek.
 */
const MAX_STRANA = 10_000

const VZOR_DATA = /^\d{4}-\d{2}-\d{2}$/
const VZOR_ID = /^[0-9a-f-]{36}$/i

/**
 * Data se formátují na SERVERU s pevnou zónou.
 *
 * Server běží v UTC, tablet v ordinaci v pražském čase. Kdyby si datum
 * poskládal každý sám, React by po hydrataci hlásil rozdíl a čas předání
 * by se po načtení stránky posunul o dvě hodiny.
 */
const FORMAT_DATUM_CAS = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Prague',
})

const FORMAT_DATUM = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/Prague',
})

/** Dnešek jako 2026-09-17, tedy v tvaru, kterému rozumí pole s datem. */
const FORMAT_ISO_DEN = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Europe/Prague',
})

/** Rozklad okamžiku na pražské hodnoty. Slouží k přepočtu hranic dne. */
const CASTI_PRAHY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Prague',
})

const NAZVY_KANALU: Record<TokenChannel, string> = {
  NFC: 'Čip',
  EMAIL: 'E-mail',
  // Odkaz vydaný ručně, bez čipu a bez e-mailu. Tisk se pozná zvlášť,
  // příznakem printed – nevydává se k němu žádný token.
  MANUAL: 'Odkaz',
}

const PORADI_KANALU: TokenChannel[] = ['NFC', 'EMAIL', 'MANUAL']

const ODKAZ_JAKO_TLACITKO =
  'inline-flex min-h-12 items-center justify-center rounded-xl bg-hlavni px-5 text-base font-semibold text-white transition-colors hover:bg-hlavni-tmavy'

const ODKAZ_V_RADKU =
  'inline-flex min-h-12 items-center font-medium underline underline-offset-4 whitespace-nowrap'

// ---------------------------------------------------------------------------
// Čtení parametrů z adresy
// ---------------------------------------------------------------------------

/** Parametr může v adrese stát vícekrát; platí první. */
function prvni(hodnota: string | string[] | undefined): string {
  return (Array.isArray(hodnota) ? hodnota[0] : hodnota) ?? ''
}

function platneDatum(hodnota: string): string {
  if (!VZOR_DATA.test(hodnota)) return ''
  const cas = Date.parse(`${hodnota}T00:00:00Z`)
  if (Number.isNaN(cas)) return ''
  // Samotný Date.parse nestačí: z 31. února udělá bez mrknutí 3. března.
  // Zpětné složení takový den odmítne, místo aby filtroval jiné období,
  // než jaké je vidět v polích.
  return new Date(cas).toISOString().slice(0, 10) === hodnota ? hodnota : ''
}

/**
 * Identifikátor se kontroluje jen na tvar.
 *
 * Že patří téhle ordinaci, se nekontroluje a ani nemá – cizí id politika RLS
 * prostě nikam netrefí a výsledek je prázdný. Kontrola proti seznamu by navíc
 * prozradila, že takový záznam jinde existuje.
 */
function platneId(hodnota: string): string {
  return VZOR_ID.test(hodnota) ? hodnota : ''
}

/**
 * Pole s datem posílá „2026-09-17“, tedy den podle hodin v ordinaci. V databázi
 * jsou okamžiky v UTC, takže se hranice dne musí přepočítat. Bez toho by filtr
 * „od 17. 9.“ v létě zahodil všechno, co se předalo do dvou hodin ráno.
 */
function posunPrahy(okamzik: Date): number {
  const casti = Object.fromEntries(
    CASTI_PRAHY.formatToParts(okamzik).map((cast) => [cast.type, cast.value]),
  )
  const jakoKdybyBylUtc = Date.UTC(
    Number(casti.year),
    Number(casti.month) - 1,
    Number(casti.day),
    Number(casti.hour),
    Number(casti.minute),
    Number(casti.second),
    // Formát jde jen po sekundy. Bez doplnění milisekund by posun vyšel
    // o necelou sekundu vedle a konec dne by se přelil do dne dalšího.
    okamzik.getUTCMilliseconds(),
  )
  return jakoKdybyBylUtc - okamzik.getTime()
}

function pragskyOkamzik(datum: string, cas: string): Date {
  const naivni = Date.parse(`${datum}T${cas}Z`)
  // Posun se čte z odhadu, ne ze zadání – a druhé kolo ho opraví i v den
  // přechodu na letní čas, kdy se první odhad trefí do jiného pásma.
  let okamzik = naivni
  for (let kolo = 0; kolo < 2; kolo += 1) {
    okamzik = naivni - posunPrahy(new Date(okamzik))
  }
  return new Date(okamzik)
}

/** Adresa téhle stránky s pozměněnými parametry. Prázdná hodnota parametr smaže. */
function odkazSParametry(
  zaklad: URLSearchParams,
  zmeny: Record<string, string>,
): string {
  const parametry = new URLSearchParams(zaklad)
  for (const [klic, hodnota] of Object.entries(zmeny)) {
    if (hodnota === '') parametry.delete(klic)
    else parametry.set(klic, hodnota)
  }
  const dotaz = parametry.toString()
  return dotaz ? `/historie?${dotaz}` : '/historie'
}

// ---------------------------------------------------------------------------
// Popisky řádku
// ---------------------------------------------------------------------------

function stitkyKanalu(polozka: HistoryItem): string[] {
  const stitky = PORADI_KANALU.filter((kanal) => polozka.channels.includes(kanal)).map(
    (kanal) => NAZVY_KANALU[kanal],
  )
  if (polozka.printed) stitky.push('Tisk')
  return stitky
}

/** Co se stalo s odkazem pro pacienta. Pořadí podmínek je důležité. */
function popisPlatnosti(polozka: HistoryItem, ted: Date): string {
  if (polozka.expiresAt === null) return '—'
  if (polozka.status === 'REVOKED' || (!polozka.hasLiveLink && polozka.expiresAt > ted)) {
    return 'Zneplatněný'
  }
  if (polozka.expiresAt <= ted) return `Vypršel ${FORMAT_DATUM.format(polozka.expiresAt)}`
  return `Platí do ${FORMAT_DATUM.format(polozka.expiresAt)}`
}

function popisOtevreni(polozka: HistoryItem): string {
  // Vytištěný balíček žádný odkaz nemá, takže se nedá otevřít ani neotevřít.
  if (polozka.channels.length === 0) return '—'
  return polozka.opened ? 'Ano' : 'Zatím ne'
}

function pocetStran(total: number): number {
  return Math.max(1, Math.ceil(total / LIMIT))
}

// ---------------------------------------------------------------------------
// Stránka
// ---------------------------------------------------------------------------

export default async function HistoriePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser()
  const parametry = await searchParams

  const od = platneDatum(prvni(parametry.od))
  const doKdy = platneDatum(prvni(parametry.do))
  const problemId = platneId(prvni(parametry.problemId))
  const createdById = platneId(prvni(parametry.createdById))
  const potvrzovany = platneId(prvni(parametry.potvrdit))

  const strana = Math.min(
    MAX_STRANA,
    Math.max(1, Math.trunc(Number(prvni(parametry.strana))) || 1),
  )

  const { historie, problemyDb, uzivateleDb } = await withPractice(
    session.user.practiceId,
    async (db) => ({
      historie: await listHistory(db, {
        ...(od ? { od: pragskyOkamzik(od, '00:00:00.000') } : {}),
        // Konec dne včetně: „do 17. 9.“ má obsáhnout i předání v 18:40.
        ...(doKdy ? { do: pragskyOkamzik(doKdy, '23:59:59.999') } : {}),
        ...(problemId ? { problemId } : {}),
        ...(createdById ? { createdById } : {}),
        limit: LIMIT,
        offset: (strana - 1) * LIMIT,
      }),
      // Do výběru patří i archivované problémy a odešlí kolegové – jejich
      // předání v historii zůstávají a musí se dát dohledat.
      problemyDb: await db.problem.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, icd10: true, archivedAt: true },
      }),
      uzivateleDb: await db.user.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, status: true },
      }),
    }),
  )

  // Do prohlížeče jdou jen vypsané hodnoty, ne záznamy z databáze: co se
  // dostane do RSC payloadu, to je v prohlížeči čitelné, i když se nevykreslí.
  const problemy: Volba[] = problemyDb.map((problem) => ({
    id: problem.id,
    label: [problem.name, problem.icd10, problem.archivedAt ? 'archivovaný' : null]
      .filter(Boolean)
      .join(' · '),
  }))

  const uzivatele: Volba[] = uzivateleDb.map((uzivatel) => ({
    id: uzivatel.id,
    label: uzivatel.status === 'DISABLED' ? `${uzivatel.name} (zablokovaný)` : uzivatel.name,
  }))

  /*
   * Odkaz na detail se sestře nenabízí vůbec.
   *
   * Detail je auditní deník jednoho předání – i s IP adresou a prohlížečem
   * pacienta – a ten podle tabulky oprávnění čte jen lékař a admin ordinace.
   * Stránka sama se ubrání, ale nabídnout odkaz, který skončí odepřením, je
   * horší než ho nenabídnout. Zneplatnit odkaz naopak smí každý z ordinace.
   */
  const smiDoDetailu = hasRole(session.user, 'DOCTOR', 'PRACTICE_ADMIN')

  const filtrujeSe = Boolean(od || doKdy || problemId || createdById)
  const celkemStran = pocetStran(historie.total)
  const ted = new Date()

  // Základ pro odkazy uvnitř stránky se skládá z OVĚŘENÝCH hodnot, takže se do
  // nich nedá adresou propašovat nic, co jsme nepřečetli.
  const zaklad = new URLSearchParams()
  if (od) zaklad.set('od', od)
  if (doKdy) zaklad.set('do', doKdy)
  if (problemId) zaklad.set('problemId', problemId)
  if (createdById) zaklad.set('createdById', createdById)
  if (strana > 1) zaklad.set('strana', String(strana))

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <header>
          <h1 className="text-2xl font-semibold">Historie předání</h1>
          <p className="mt-1 max-w-3xl text-text-tlumeny">
            Co ordinace komu předala, kdy a jakou cestou. Dokumenty samotné tu nejsou – jen
            záznam o předání a stav odkazu, který pacient dostal.
          </p>
        </header>

        {/*
          Klíč vynutí nové připojení komponenty, kdykoli se filtr v adrese změní.
          Bez něj by si pole po kliknutí na „Zrušit filtr“ podržela starý obsah:
          React drží stav komponenty na stejném místě stromu napříč navigacemi.
        */}
        <Filtr
          key={`${od}|${doKdy}|${problemId}|${createdById}`}
          problemy={problemy}
          uzivatele={uzivatele}
          hodnoty={{ od, do: doKdy, problemId, createdById }}
          dnes={FORMAT_ISO_DEN.format(ted)}
        />

        {historie.total === 0 ? (
          filtrujeSe ? (
            <PrazdnyFiltr />
          ) : (
            <PrazdnaHistorie />
          )
        ) : historie.items.length === 0 ? (
          <ZaKoncem odkaz={odkazSParametry(zaklad, { strana: '', potvrdit: '' })} />
        ) : (
          <section aria-labelledby="nadpis-seznam" className="space-y-4">
            <h2 id="nadpis-seznam" className="sr-only">
              Seznam předání
            </h2>

            {/* Rámeček se kreslí ručně, ne přes Card: tabulka potřebuje odsazení
                uvnitř buněk, ne kolem celé karty. */}
            <div className="overflow-x-auto rounded-2xl border border-obrys bg-plocha shadow-sm">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Předané balíčky, od nejnovějšího. Strana {strana} z {celkemStran}.
                </caption>
                <thead>
                  <tr className="border-b border-obrys text-text-tlumeny">
                    <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      Kdy
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Pacient
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Problém
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Předal
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Dokumentů
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Kanál
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      Otevřeno
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Platnost odkazu
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      <span className="sr-only">Akce</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {historie.items.map((polozka) => {
                    const kdy = FORMAT_DATUM_CAS.format(polozka.createdAt)
                    const kanaly = stitkyKanalu(polozka)
                    const potvrzuje = polozka.hasLiveLink && potvrzovany === polozka.id

                    return (
                      <Fragment key={polozka.id}>
                        <tr className="border-b border-obrys last:border-b-0">
                          <th
                            scope="row"
                            className="px-4 py-4 text-left font-medium whitespace-nowrap"
                          >
                            {kdy}
                          </th>

                          <td className="px-4 py-4">
                            {polozka.patientLabel ? (
                              polozka.patientLabel
                            ) : (
                              <span className="text-text-tlumeny">—</span>
                            )}
                          </td>

                          <td className="px-4 py-4">
                            {polozka.problemName ?? (
                              <span className="text-text-tlumeny">Bez problému</span>
                            )}
                          </td>

                          <td className="px-4 py-4 text-text-tlumeny">{polozka.createdByName}</td>

                          <td className="px-4 py-4 text-right tabular-nums">
                            {polozka.documentCount}
                          </td>

                          <td className="px-4 py-4">
                            {kanaly.length === 0 ? (
                              <span className="text-text-tlumeny">Nepředáno</span>
                            ) : (
                              <span className="flex flex-wrap gap-1.5">
                                {kanaly.map((stitek) => (
                                  <span
                                    key={stitek}
                                    className="inline-flex items-center rounded-md border border-obrys bg-podklad px-2 py-0.5 text-xs font-medium whitespace-nowrap"
                                  >
                                    {stitek}
                                  </span>
                                ))}
                              </span>
                            )}
                          </td>

                          <td className="px-4 py-4 whitespace-nowrap">
                            {popisOtevreni(polozka)}
                          </td>

                          <td className="px-4 py-4 whitespace-nowrap text-text-tlumeny">
                            {popisPlatnosti(polozka, ted)}
                          </td>

                          <td className="px-4 py-4">
                            <span className="flex flex-wrap items-center justify-end gap-x-4">
                              {smiDoDetailu ? (
                                <Link
                                  href={`/historie/${polozka.id}`}
                                  className={`${ODKAZ_V_RADKU} text-hlavni hover:text-hlavni-tmavy`}
                                  aria-label={`Podrobnosti předání z ${kdy}`}
                                >
                                  Podrobnosti
                                </Link>
                              ) : null}

                              {polozka.hasLiveLink && !potvrzuje ? (
                                // Mezikrok je odkaz, ne okno v prohlížeči:
                                // funguje bez JavaScriptu a na tabletu se
                                // o nevratnou akci nedá zavadit palcem.
                                <Link
                                  href={odkazSParametry(zaklad, { potvrdit: polozka.id })}
                                  scroll={false}
                                  className={`${ODKAZ_V_RADKU} text-chyba hover:text-text`}
                                  aria-label={`Zneplatnit odkaz předaný ${kdy}`}
                                >
                                  Zneplatnit odkaz
                                </Link>
                              ) : null}
                            </span>
                          </td>
                        </tr>

                        {potvrzuje ? (
                          <tr className="border-b border-obrys bg-podklad last:border-b-0">
                            <td colSpan={9} className="px-4 py-4">
                              <form
                                action={zneplatnitOdkaz}
                                className="flex flex-wrap items-center justify-end gap-x-4 gap-y-3"
                              >
                                <input type="hidden" name="packageId" value={polozka.id} />

                                <p className="mr-auto max-w-2xl">
                                  Zneplatnit odkaz z {kdy}
                                  {polozka.patientLabel ? ` (${polozka.patientLabel})` : ''}?
                                  Pacient se k dokumentům okamžitě přestane dostávat a vrátit to
                                  nejde – další předání by znamenalo připravit balíček znovu.
                                </p>

                                <Button type="submit" variant="vedlejsi">
                                  Ano, zneplatnit
                                </Button>

                                <Link
                                  href={odkazSParametry(zaklad, { potvrdit: '' })}
                                  scroll={false}
                                  className={`${ODKAZ_V_RADKU} text-text-tlumeny hover:text-text`}
                                >
                                  Zpět
                                </Link>
                              </form>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="max-w-3xl text-sm text-text-tlumeny">
              Po vypršení platnosti se dokumenty i označení pacienta mažou – zůstane jen
              záznam, že se něco předalo.
              {smiDoDetailu
                ? ' Co přesně balíček obsahoval a jak si ho pacient otevíral, ukáže odkaz Podrobnosti.'
                : ''}
            </p>

            <Strankovani
              strana={strana}
              celkemStran={celkemStran}
              total={historie.total}
              zaklad={zaklad}
            />
          </section>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dílčí kusy stránky
// ---------------------------------------------------------------------------

function Strankovani({
  strana,
  celkemStran,
  total,
  zaklad,
}: {
  strana: number
  celkemStran: number
  total: number
  zaklad: URLSearchParams
}) {
  // Jediná strana nepotřebuje ovládání, jen počet – aby bylo jasné, že je vidět vše.
  if (celkemStran === 1) {
    return <p className="text-sm text-text-tlumeny">Celkem {total} předání.</p>
  }

  const predchozi =
    strana > 1
      ? odkazSParametry(zaklad, {
          strana: strana - 1 === 1 ? '' : String(strana - 1),
          potvrdit: '',
        })
      : null

  const dalsi =
    strana < celkemStran
      ? odkazSParametry(zaklad, { strana: String(strana + 1), potvrdit: '' })
      : null

  return (
    <nav
      aria-label="Stránkování historie"
      className="flex flex-wrap items-center justify-between gap-4"
    >
      {predchozi ? (
        <Link href={predchozi} className={`${ODKAZ_V_RADKU} text-hlavni hover:text-hlavni-tmavy`}>
          <span aria-hidden="true" className="mr-2">
            &larr;
          </span>
          Předchozí
        </Link>
      ) : (
        <span className="inline-flex min-h-12 items-center text-text-tlumeny">Předchozí</span>
      )}

      <p className="text-sm text-text-tlumeny">
        Strana {strana} z {celkemStran} · celkem {total} předání
      </p>

      {dalsi ? (
        <Link href={dalsi} className={`${ODKAZ_V_RADKU} text-hlavni hover:text-hlavni-tmavy`}>
          Další
          <span aria-hidden="true" className="ml-2">
            &rarr;
          </span>
        </Link>
      ) : (
        <span className="inline-flex min-h-12 items-center text-text-tlumeny">Další</span>
      )}
    </nav>
  )
}

function PrazdnaHistorie() {
  return (
    <Card className="space-y-4 sm:p-8">
      <h2 className="text-xl font-semibold">Zatím se nic nepředalo</h2>
      <p className="max-w-3xl text-text-tlumeny">
        Jakmile balíček předáte – přes čip, e-mailem nebo vytištěním – objeví se tady řádek:
        kdy to bylo, komu, ke kterému problému, kolik dokumentů a jestli si je pacient
        otevřel. Rozpracované balíčky se sem nepočítají.
      </p>
      <p className="max-w-3xl text-sm text-text-tlumeny">
        Slouží to ke dvěma věcem: dohledat, co pacient dostal, když zavolá, a odvolat odkaz,
        pokud se dostal k nesprávnému člověku.
      </p>
      <p>
        <Link href="/" className={ODKAZ_JAKO_TLACITKO}>
          Připravit balíček
        </Link>
      </p>
    </Card>
  )
}

function PrazdnyFiltr() {
  return (
    <Card className="space-y-4 sm:p-8">
      <h2 className="text-xl font-semibold">Filtru neodpovídá žádné předání</h2>
      <p className="max-w-3xl text-text-tlumeny">
        Zkuste prosím širší období nebo pusťte problém či kolegu z výběru. Připomínáme, že
        podle jména pacienta hledat nejde – označení pacienta je zašifrované.
      </p>
      <p>
        <Link
          href="/historie"
          className="inline-flex min-h-12 items-center font-medium text-hlavni underline underline-offset-4 hover:text-hlavni-tmavy"
        >
          Zrušit filtr
        </Link>
      </p>
    </Card>
  )
}

function ZaKoncem({ odkaz }: { odkaz: string }) {
  return (
    <Card className="space-y-4 sm:p-8">
      <h2 className="text-xl font-semibold">Tady už nic není</h2>
      <p className="max-w-3xl text-text-tlumeny">
        Na téhle straně žádná předání nejsou – nejspíš jich mezitím ubylo, nebo je v adrese
        větší číslo strany, než kolik jich existuje.
      </p>
      <p>
        <Link
          href={odkaz}
          className="inline-flex min-h-12 items-center font-medium text-hlavni underline underline-offset-4 hover:text-hlavni-tmavy"
        >
          Zpět na první stranu
        </Link>
      </p>
    </Card>
  )
}
