'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

import { Alert, Button, Card } from '@/components/ui'

/**
 * Obrazovka s kódem – tuhle lékař otočí k pacientovi.
 *
 * KÓD SE NEDÁ NAČÍST ZE SERVERU. V databázi je z něj jen HMAC s pepperem
 * a v čitelné podobě existuje jedinkrát: v odpovědi na POST
 * /api/predani/aktivovat. Na obrazovku se proto dostane jednou ze dvou cest
 * a obě jsou tady:
 *
 *  1. Rovnou ve vlastnosti `kod`. Tudy chodí modální okno na hlavní
 *     obrazovce, kde odpověď z aktivace drží komponenta o kus výš. Kód
 *     neopustí paměť Reactu – to je nejbezpečnější, a proto hlavní cesta.
 *
 *  2. Jednorázovým předáním přes sessionStorage (viz predejKod níže), když se
 *     na /predani/<id> opravdu naviguje. Jiné úložiště v úvahu nepřipadá:
 *     kód v adrese by zůstal v historii prohlížeče i v logu proxy,
 *     localStorage by přežil zavření karty a platí přitom tři minuty.
 *
 * Když kód není ani jednou cestou (lékař obnovil stránku), obrazovka to
 * přizná a nabídne předání zrušit. Vykouzlit ho zpátky nejde a předstírat
 * opak by bylo horší než to říct.
 */

export type StavPredani = 'ACTIVE' | 'CLAIMED' | 'EXPIRED' | 'CANCELLED' | 'LOCKED'

/** Devadesát dotazů za celé tříminutové okno – proti trvalému spojení nic. */
const INTERVAL_DOTAZU_MS = 2_000

/** Od kolika sekund odpočet zčervená. */
const CERVENE_OD_S = 10

/**
 * Výchozí `maxCodeAttempts` ordinace.
 *
 * Rozhraní vrací jen zbývající pokusy, ne strop. Plný počet znamená, že se
 * pacient ještě nespletl – a psát mu přes stůl, kolik má pokusů, dokud o žádný
 * nepřišel, ho jen zbytečně znervózňuje.
 */
const PLNY_POCET_POKUSU = 5

/** Kolik dotazů po sobě smí selhat, než se o tom lékaři řekne. */
const TICHA_SELHANI = 3

const KLIC_KODU = 'medpredani-kod-predani'

/**
 * Kód drží i proměnná v modulu, nejen sessionStorage.
 *
 * Z úložiště se vybírá JEDNOU a hned se maže, takže druhé připojení komponenty
 * – ve vývoji ho React ve StrictMode udělá vždycky – už nic nenajde. Tahle
 * proměnná žije jen v paměti karty a při obnovení stránky se ztratí, což je
 * přesně to chování, které chceme.
 */
let vPameti: { activationId: string; kod: string } | null = null

/**
 * Předá kód obrazovce /predani/<id>.
 *
 * Volá se těsně před navigací, tedy `predejKod(id, kod)` a hned
 * `router.push('/predani/' + id)`. Obrazovka si kód vyzvedne a smaže.
 */
export function predejKod(activationId: string, kod: string): void {
  vPameti = { activationId, kod }
  try {
    sessionStorage.setItem(KLIC_KODU, JSON.stringify({ activationId, kod }))
  } catch {
    // Soukromé okno nebo zakázané úložiště. Navigace se tím nemá zastavit:
    // obrazovka si poradí i bez kódu a řekne, co s tím.
  }
}

function prevezmiKod(activationId: string): string | null {
  if (vPameti?.activationId === activationId) return vPameti.kod

  try {
    const ulozene = sessionStorage.getItem(KLIC_KODU)
    if (!ulozene) return null
    sessionStorage.removeItem(KLIC_KODU)

    const data: unknown = JSON.parse(ulozene)
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { activationId?: unknown }).activationId !== activationId ||
      !/^\d{4}$/.test(String((data as { kod?: unknown }).kod))
    ) {
      return null
    }

    vPameti = { activationId, kod: String((data as { kod: unknown }).kod) }
    return vPameti.kod
  } catch {
    return null
  }
}

/** Po skončení předání kód k ničemu není a nemá se kde válet. */
function zapomenKod(): void {
  vPameti = null
  try {
    sessionStorage.removeItem(KLIC_KODU)
  } catch {
    // Viz predejKod – zakázané úložiště není důvod cokoli hlásit.
  }
}

function zbyvaSekund(cil: number): number {
  return Math.max(0, Math.ceil((cil - Date.now()) / 1000))
}

function odpocet(sekundy: number): string {
  return `${Math.floor(sekundy / 60)}:${String(sekundy % 60).padStart(2, '0')}`
}

function pokusySlovem(pocet: number): string {
  if (pocet === 1) return 'Zbývá poslední pokus'
  if (pocet >= 2 && pocet <= 4) return `Zbývají ${pocet} pokusy`
  return `Zbývá ${pocet} pokusů`
}

const STAVY: readonly string[] = ['ACTIVE', 'CLAIMED', 'EXPIRED', 'CANCELLED', 'LOCKED']

function jeStav(hodnota: unknown): hodnota is StavPredani {
  return typeof hodnota === 'string' && STAVY.includes(hodnota)
}

type KodProps = {
  activationId: string
  /** ISO 8601. Odpočet běží jen v prohlížeči, tak se čas formátuje až tam. */
  expiresAt: string
  stav: StavPredani
  /** Kód v čitelné podobě, když ho volající má. Viz komentář nahoře. */
  kod?: string | null
  /** Zbývající pokusy, pokud je volající zná – ušetří dvě sekundy čekání. */
  pokusuZbyva?: number | null
  /** Co po předání. Výchozí je návrat na přípravu balíčku. */
  onHotovo?: () => void
  /** Co po vypršení, zamčení nebo zrušení. Výchozí je totéž. */
  onZkusitZnovu?: () => void
}

export function Kod({
  activationId,
  expiresAt,
  stav,
  kod = null,
  pokusuZbyva = null,
  onHotovo,
  onZkusitZnovu,
}: KodProps) {
  const router = useRouter()

  /** Délka okna z prvního naměřeného zbytku – slouží ubývající lince. */
  const celkemRef = useRef<number | null>(null)
  const [serverStav, setServerStav] = useState<StavPredani>(stav)
  const [pokusy, setPokusy] = useState<number | null>(pokusuZbyva)
  const [prevzaty, setPrevzaty] = useState<{ nacteno: boolean; kod: string | null }>({
    nacteno: kod !== null,
    kod,
  })
  const [chyba, setChyba] = useState<string | null>(null)
  const [vaznouciSpojeni, setVaznouciSpojeni] = useState(false)
  const [rusim, setRusim] = useState(false)

  const cil = useMemo(() => new Date(expiresAt).getTime(), [expiresAt])
  const [zbyva, setZbyva] = useState(() => zbyvaSekund(cil))

  /*
   * Výměna aktivace bez odpojení komponenty – to nastane u modálního okna,
   * které zůstane otevřené a dostane nový kód. Bez tohohle by nad novým kódem
   * svítilo „Předáno“ od předchozího pacienta.
   */
  const [ktera, setKtera] = useState(activationId)
  if (ktera !== activationId) {
    setKtera(activationId)
    setServerStav(stav)
    setPokusy(pokusuZbyva)
    setPrevzaty({ nacteno: kod !== null, kod })
    setChyba(null)
    setVaznouciSpojeni(false)
  }

  // Kód z úložiště se vyzvedává až po připojení ke stránce. Na serveru žádné
  // sessionStorage není, takže jinak by se serverová a klientská podoba
  // stránky rozešly a React by celou stránku překreslil.
  useEffect(() => {
    if (kod !== null) return
    setPrevzaty({ nacteno: true, kod: prevezmiKod(activationId) })
  }, [activationId, kod])

  // Odpočet. Čas se vždycky POČÍTÁ z cíle, ne odečítá po sekundě – uspané
  // kartě prohlížeč časovač pozastaví a odečítaný zbytek by po probuzení lhal.
  useEffect(() => {
    setZbyva(zbyvaSekund(cil))
    if (serverStav !== 'ACTIVE') return

    const casovac = window.setInterval(() => setZbyva(zbyvaSekund(cil)), 1_000)
    return () => window.clearInterval(casovac)
  }, [cil, serverStav])

  // Dotazování na stav. Běží jen tak dlouho, dokud je na co čekat.
  useEffect(() => {
    if (serverStav !== 'ACTIVE') return

    const rizeni = new AbortController()
    let casovac = 0
    let probiha = false
    let selhani = 0

    async function zeptejSe(): Promise<void> {
      // Pomalá odpověď nesmí nastartovat druhý dotaz – u zahlcené sítě by se
      // požadavky nabalovaly rychleji, než by se stíhaly vyřizovat.
      if (probiha) return
      probiha = true

      try {
        const odpoved = await fetch(
          `/api/predani/${encodeURIComponent(activationId)}/stav`,
          { signal: rizeni.signal, cache: 'no-store' },
        )

        if (odpoved.status === 401) {
          window.clearInterval(casovac)
          setChyba('Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.')
          return
        }

        // Chyba serveru bývá dočasná – restart instance, krátký výpadek
        // databáze. Zastavit dotazování natrvalo by znamenalo, že lékař
        // neuvidí „Předáno", i když pacient kód mezitím v pořádku opsal.
        // Zachází se s ní proto stejně jako s výpadkem sítě: tři pokusy.
        if (odpoved.status >= 500) {
          selhani += 1
          if (selhani >= 3) setVaznouciSpojeni(true)
          return
        }

        // 404 a jiné trvalé chyby smysl opakovat nemají.
        if (!odpoved.ok) {
          window.clearInterval(casovac)
          setChyba('Stav předání se nepodařilo zjistit. Načtěte prosím stránku znovu.')
          return
        }

        const data: unknown = await odpoved.json()
        const status = (data as { status?: unknown }).status
        const attemptsLeft = (data as { attemptsLeft?: unknown }).attemptsLeft

        selhani = 0
        setVaznouciSpojeni(false)
        if (typeof attemptsLeft === 'number') setPokusy(attemptsLeft)
        // Neznámý stav se raději ignoruje, než aby obrazovka zhasla: kód na
        // ní pořád platí a server ho zná, i když si rozhraní přestalo rozumět.
        if (jeStav(status)) setServerStav(status)
      } catch {
        if (rizeni.signal.aborted) return

        // Jeden výpadek nic neznamená a kód pořád platí. Poplach se spouští
        // až po několika pokusech po sobě.
        selhani += 1
        if (selhani >= TICHA_SELHANI) setVaznouciSpojeni(true)
      } finally {
        probiha = false
      }
    }

    casovac = window.setInterval(zeptejSe, INTERVAL_DOTAZU_MS)

    return () => {
      window.clearInterval(casovac)
      rizeni.abort()
    }
  }, [activationId, serverStav])

  useEffect(() => {
    if (serverStav === 'ACTIVE') return
    zapomenKod()
  }, [serverStav])

  const hotovo = useCallback(() => {
    if (onHotovo) {
      onHotovo()
      return
    }
    // replace, ne push: vrátit se tlačítkem zpět na doběhlé předání nemá smysl.
    router.replace('/')
  }, [onHotovo, router])

  const znovu = useCallback(() => {
    if (onZkusitZnovu) {
      onZkusitZnovu()
      return
    }
    router.replace('/')
  }, [onZkusitZnovu, router])

  const zrus = useCallback(async () => {
    setChyba(null)
    setRusim(true)

    try {
      const odpoved = await fetch(`/api/predani/${encodeURIComponent(activationId)}/zrusit`, {
        method: 'POST',
      })

      if (!odpoved.ok) {
        const telo = (await odpoved.json().catch(() => null)) as { error?: string } | null
        setChyba(telo?.error ?? 'Předání se nepodařilo zrušit. Zkuste to prosím znovu.')
        return
      }

      // Server potvrdil, čekat na další dotaz by jen protáhlo odezvu.
      setServerStav('CANCELLED')
    } catch {
      setChyba(
        'Spojení se serverem se přerušilo, předání se nepodařilo zrušit. Kód přestane platit sám.',
      )
    } finally {
      setRusim(false)
    }
  }, [activationId])

  /*
   * Vypršení se pozná i bez serveru – a stejně, jako ho pozná on: porovnáním
   * času. Lékař tedy nekouká na mrtvý kód další dvě sekundy. Kdyby to pacient
   * stihl o vteřinu dřív, dotazování ještě běží a obrazovka přepne na
   * „Předáno“.
   */
  const zobrazenyStav: StavPredani =
    serverStav === 'ACTIVE' && zbyva <= 0 ? 'EXPIRED' : serverStav

  if (zobrazenyStav === 'CLAIMED') {
    return (
      <Vysledek barva="text-uspech" ikona={<IkonaFajfka />} nadpis="Předáno">
        <p className="text-lg text-text-tlumeny">Pacient má dokumenty ve svém telefonu.</p>
        <Button type="button" onClick={hotovo} className="min-w-52">
          Hotovo
        </Button>
      </Vysledek>
    )
  }

  if (zobrazenyStav === 'EXPIRED') {
    return (
      <Vysledek barva="text-varovani" ikona={<IkonaHodiny />} nadpis="Čas vypršel">
        <p className="text-lg text-text-tlumeny">
          Kód už neplatí a nic se nepředalo. Spusťte předání znovu.
        </p>
        <Button type="button" onClick={znovu} className="min-w-52">
          Zkusit znovu
        </Button>
      </Vysledek>
    )
  }

  if (zobrazenyStav === 'LOCKED') {
    return (
      <Vysledek
        barva="text-chyba"
        ikona={<IkonaZamek />}
        nadpis="Příliš mnoho pokusů o zadání kódu"
      >
        <p className="text-lg text-text-tlumeny">
          Předání jsme kvůli bezpečnosti zastavili. Spusťte ho znovu a ukažte pacientovi nový kód.
        </p>
        <Button type="button" onClick={znovu} className="min-w-52">
          Zkusit znovu
        </Button>
      </Vysledek>
    )
  }

  if (zobrazenyStav === 'CANCELLED') {
    return (
      <Vysledek barva="text-text-tlumeny" ikona={<IkonaKrizek />} nadpis="Předání zrušeno">
        <p className="text-lg text-text-tlumeny">
          Nic se nepředalo. Připravený balíček zůstal, kdykoli ho jde předat znovu.
        </p>
        <Button type="button" variant="vedlejsi" onClick={znovu} className="min-w-52">
          Zpět na přípravu
        </Button>
      </Vysledek>
    )
  }

  const zobrazenyKod = kod ?? prevzaty.kod
  const cislice = zobrazenyKod ? [...zobrazenyKod] : null

  /*
   * Podíl zbývajícího času pro ubývající linku. Celkovou délku okna
   * komponenta nezná (server vrací jen okamžik vypršení), takže se bere
   * z prvního naměřeného zbytku – okno se otevírá hned po aktivaci.
   */
  if (celkemRef.current === null && zbyva > 0) celkemRef.current = zbyva
  const podilZbyva = celkemRef.current ? Math.max(0, Math.min(100, (zbyva / celkemRef.current) * 100)) : 100

  return (
    <div className="space-y-6">
      <Card className="space-y-8 text-center sm:p-10">
        <h1 className="text-2xl font-semibold">Kód pro pacienta</h1>

        {prevzaty.nacteno && !cislice ? (
          <Alert tone="info">
            Kód se ukazuje jen na obrazovce, ze které jste předání spustili – po obnovení stránky
            už ho zobrazit nejde. Zrušte prosím předání a spusťte ho znovu.
          </Alert>
        ) : (
          /*
           * Tmavý panel je jediné místo v aplikaci, kde se obrací barvy.
           * Je to schválně: tohle je ten jeden okamžik, kdy se na obrazovku
           * dívá PACIENT přes stůl, a musí být na první pohled jasné, že
           * tahle část patří jemu, ne lékaři. Signální barva se nikde jinde
           * nepoužívá, takže se s ničím neplete.
           */
          <div className="-mx-6 rounded-2xl bg-inkoust px-6 py-8 sm:-mx-10 sm:px-10">
            {cislice ? (
              // Čtečka obrazovky má přečíst kód po číslicích, ne jako číslo
              // „čtyři tisíce osm set dvacet jedna“.
              <p className="sr-only">Kód {cislice.join(' ')}</p>
            ) : null}

            <div aria-hidden="true" className="flex justify-center gap-2.5 sm:gap-4">
              {(cislice ?? ['', '', '', '']).map((znak, poradi) => (
                <span
                  key={poradi}
                  className="udaj flex h-28 min-w-[4.5rem] items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] text-6xl leading-none font-semibold text-signal sm:h-36 sm:min-w-28 sm:text-8xl"
                >
                  {znak}
                </span>
              ))}
            </div>

            {/*
              Odpočet jako ubývající linka pod číslicemi. Pacient i lékař
              vidí zbývající čas periferně, aniž by museli číst údaj.
            */}
            <div className="mx-auto mt-7 max-w-md">
              <div className="h-px w-full bg-white/15">
                <div
                  className="h-px bg-signal transition-[width] duration-1000 ease-linear"
                  style={{ width: `${podilZbyva}%` }}
                />
              </div>
              <p className="mt-3 text-center text-sm text-white/70">
                Platí ještě{' '}
                {/* Server a prohlížeč odbaví stránku každý o zlomek sekundy
                    jinde, takže se první vykreslení může lišit o vteřinu.
                    Je to jediná hodnota, u které je to v pořádku. */}
                <span
                  suppressHydrationWarning
                  className={[
                    'udaj font-semibold',
                    zbyva < CERVENE_OD_S ? 'text-signal' : 'text-white',
                  ].join(' ')}
                >
                  {odpocet(zbyva)}
                </span>
              </p>
            </div>
          </div>
        )}

        {pokusy !== null && pokusy < PLNY_POCET_POKUSU ? (
          <p role="status" className="font-medium text-varovani">
            Zadaný kód nesouhlasil. {pokusySlovem(pokusy)}.
          </p>
        ) : null}

        <div className="mx-auto max-w-lg text-left">
          <h2 className="mb-3 text-center text-lg font-semibold">Jak na to</h2>
          <ol className="space-y-3 text-lg">
            <Krok cislo={1}>Přiložte telefon k čipu.</Krok>
            <Krok cislo={2}>V telefonu se otevře stránka s políčkem na kód.</Krok>
            <Krok cislo={3}>Opište do telefonu kód z téhle obrazovky.</Krok>
          </ol>
          <p className="mt-4 text-center text-text-tlumeny">
            Dokumenty se vám pak otevřou přímo v telefonu.
          </p>
        </div>
      </Card>

      {chyba ? <Alert tone="chyba">{chyba}</Alert> : null}

      {vaznouciSpojeni ? (
        <Alert tone="info">
          Spojení se serverem vázne, obrazovka se nemusí sama přepnout. Kód mezitím platí dál.
        </Alert>
      ) : null}

      <div className="text-center">
        <Button type="button" variant="vedlejsi" onClick={zrus} disabled={rusim}>
          {rusim ? 'Ruším…' : 'Zrušit předání'}
        </Button>
      </div>
    </div>
  )
}

function Krok({ cislo, children }: { cislo: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hlavni font-semibold text-white tabular-nums"
      >
        {cislo}
      </span>
      <span>{children}</span>
    </li>
  )
}

/**
 * Konec předání – ať dopadl jakkoli.
 *
 * Výsledek je vidět přes stůl a nese jen jednu informaci, takže je na
 * obrazovce sám. role="status" ho oznámí i tomu, kdo se nedívá.
 */
function Vysledek({
  barva,
  ikona,
  nadpis,
  children,
}: {
  barva: string
  ikona: ReactNode
  nadpis: string
  children: ReactNode
}) {
  return (
    <Card className="sm:p-10">
      <div role="status" className="flex flex-col items-center gap-6 text-center">
        <span
          className={['flex h-28 w-28 items-center justify-center rounded-full bg-podklad', barva].join(
            ' ',
          )}
        >
          {ikona}
        </span>
        <h1 className={['text-4xl font-semibold', barva].join(' ')}>{nadpis}</h1>
        {children}
      </div>
    </Card>
  )
}

function Ikona({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-16 w-16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

function IkonaFajfka() {
  return (
    <Ikona>
      <path d="M4 12.5 9.5 18 20 6.5" />
    </Ikona>
  )
}

function IkonaHodiny() {
  return (
    <Ikona>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 2" />
    </Ikona>
  )
}

function IkonaZamek() {
  return (
    <Ikona>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Ikona>
  )
}

function IkonaKrizek() {
  return (
    <Ikona>
      <path d="M7 7l10 10M17 7 7 17" />
    </Ikona>
  )
}
