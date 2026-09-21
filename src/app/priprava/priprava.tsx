'use client'

import { useCallback, useRef, useState } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'
import { Akce } from './akce'
import { VyberProblemu } from './vyber-problemu'
import { Zprava, type NahranaZprava } from './zprava'

/**
 * Příprava balíčku pro pacienta – hlavní obrazovka aplikace.
 *
 * Celý tok drží jedna komponenta, protože to je jeden úkon: najít problém,
 * odškrtnout, co pacient nepotřebuje, přiložit lékařskou zprávu a předat.
 * Rozdělení na kroky s potvrzováním by přidalo kliknutí, kterých má být
 * co nejméně – lékař tuhle obrazovku používá desetkrát denně.
 */

export type DokumentVolba = {
  /**
   * Do balíčku se ukládá konkrétní VERZE, ne dokument. Po aktualizaci letáku
   * v knihovně tak dřív předané balíčky zůstanou pravdivé.
   */
  versionId: string
  title: string
  pageCount: number
}

export type ProblemVolba = {
  id: string
  name: string
  icd10: string | null
  documents: DokumentVolba[]
}

/** Stejný strop jako `patientLabel` v PUT /api/balicky. */
const MAX_OZNACENI = 120

export function Priprava({ vychoziProblemy }: { vychoziProblemy: ProblemVolba[] }) {
  const [problem, setProblem] = useState<ProblemVolba | null>(null)

  /*
   * Pamatují se ODŠKRTNUTÉ dokumenty, ne zaškrtnuté.
   *
   * Předvybrané je všechno, co k problému patří – to je celý smysl knihovny.
   * Výjimky bývají jedna dvě, takže se nemusí nic dopočítávat při výběru
   * problému a nemůže se stát, že by se seznam a zaškrtnutí rozešly.
   */
  const [odskrtnute, setOdskrtnute] = useState<ReadonlySet<string>>(() => new Set())

  const [zprava, setZprava] = useState<NahranaZprava | null>(null)
  const [oznaceni, setOznaceni] = useState('')
  const [packageId, setPackageId] = useState<string | null>(null)
  const [predano, setPredano] = useState(false)
  /**
   * Nahrávání zprávy běží. Drží se tady, ne uvnitř Zpravy, protože o něm musí
   * vědět i tlačítka – jinak by šlo vytisknout balíček bez zprávy, která se
   * zrovna posílá.
   */
  const [nahravamZpravu, setNahravamZpravu] = useState(false)
  const [chyba, setChyba] = useState<string | null>(null)

  /*
   * Pořadové číslo rozdělaného balíčku.
   *
   * Slouží jako klíč podřízených částí: po „Nový balíček“ se vymění a Reactu
   * tím řekne, že tohle už je jiný pacient. Zahodí se s nimi i to, co si drží
   * samy – hlavně stažené PDF předchozího pacienta, které by jinak zůstalo
   * dostupné odkazem na uklizené obrazovce.
   */
  const [relace, setRelace] = useState(0)

  /*
   * Identifikátor balíčku i v referenci, ne jen ve stavu.
   *
   * Nahrání zprávy a kliknutí na akci mohou běžet těsně po sobě a stav se
   * v Reactu nastaví až při dalším vykreslení – dva souběžné pokusy by jinak
   * založily dva balíčky a jeden by zůstal viset prázdný.
   */
  const balicekRef = useRef<string | null>(null)
  const zakladani = useRef<Promise<string> | null>(null)

  const vybraneSablony = problem
    ? problem.documents.filter((dokument) => !odskrtnute.has(dokument.versionId))
    : []

  const pocetDokumentu = vybraneSablony.length + (zprava ? 1 : 0)
  const celkemStran =
    vybraneSablony.reduce((soucet, dokument) => soucet + dokument.pageCount, 0) +
    (zprava?.pageCount ?? 0)

  /**
   * Balíček se zakládá LÍNĚ – až když je opravdu potřeba, tedy při prvním
   * nahrání zprávy nebo při první akci.
   *
   * Kdyby vznikal hned při otevření obrazovky nebo při výběru problému,
   * zaplnila by se historie rozpracovanými balíčky pokaždé, když si někdo jen
   * prohlédne, co ke které diagnóze v knihovně je. Do historie patří to, co se
   * opravdu dělo s pacientem.
   */
  const zajistiBalicek = useCallback(async (): Promise<string> => {
    const existujici = balicekRef.current ?? packageId
    if (existujici) return existujici
    if (zakladani.current) return zakladani.current

    // problemId se posílá jen při zakládání – PUT ho už měnit neumí.
    const prace = odesli<{ packageId: string }>('/api/balicky', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(problem ? { problemId: problem.id } : {}),
    })
      .then((data) => {
        balicekRef.current = data.packageId
        setPackageId(data.packageId)
        return data.packageId
      })
      .finally(() => {
        zakladani.current = null
      })

    zakladani.current = prace
    return prace
  }, [packageId, problem])

  /**
   * Uloží výběr a vrátí balíček připravený k předání.
   *
   * Volá se před každou akcí, ne po každém kliknutí na zaškrtávátko: server
   * pak dostane jeden zápis místo deseti a v auditu je jedna úprava místo
   * série šumu.
   */
  const pripravit = useCallback(async (): Promise<string> => {
    const id = await zajistiBalicek()

    /*
     * Pořadí v poli je pořadím, ve kterém se dokumenty sloučí k tisku.
     * Drží se tvaru obrazovky: nejdřív dokumenty z knihovny tak, jak jsou
     * vypsané, a lékařská zpráva až za nimi, protože na obrazovce je pod nimi.
     */
    const documents = [
      ...vybraneSablony.map((dokument) => ({
        kind: 'TEMPLATE' as const,
        templateVersionId: dokument.versionId,
      })),
      ...(zprava ? [{ kind: 'UPLOAD' as const, uploadedFileId: zprava.uploadedFileId }] : []),
    ]

    await odesli<unknown>('/api/balicky', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: id,
        documents,
        patientLabel: oznaceni.trim() || null,
      }),
    })

    return id
  }, [oznaceni, vybraneSablony, zajistiBalicek, zprava])

  /** Vrátí obrazovku do výchozího stavu pro dalšího pacienta. */
  const zacniZnovu = useCallback(() => {
    balicekRef.current = null
    setPackageId(null)
    setProblem(null)
    setOdskrtnute(new Set())
    setZprava(null)
    setOznaceni('')
    setPredano(false)
    setChyba(null)
    setRelace((poradi) => poradi + 1)
  }, [])

  function vyberProblem(novy: ProblemVolba): void {
    /*
     * Předaný balíček se nesmí přepsat. Výběr problému po předání znamená
     * dalšího pacienta, takže se začíná načisto – jinak by se do balíčku
     * prvního pacienta zapsaly dokumenty druhého a historie by lhala.
     */
    if (predano) zacniZnovu()

    setProblem(novy)
    setOdskrtnute(new Set())
    setChyba(null)
  }

  function prepniDokument(versionId: string): void {
    setOdskrtnute((puvodni) => {
      const dalsi = new Set(puvodni)
      if (dalsi.has(versionId)) dalsi.delete(versionId)
      else dalsi.add(versionId)
      return dalsi
    })
  }

  function prepniVse(): void {
    if (!problem) return
    setOdskrtnute(
      vybraneSablony.length > 0
        ? new Set(problem.documents.map((dokument) => dokument.versionId))
        : new Set(),
    )
  }

  return (
    <div className="space-y-8">
      <h1 className="sr-only">Příprava balíčku pro pacienta</h1>

      <VyberProblemu
        key={`problem-${relace}`}
        problemy={vychoziProblemy}
        vybrany={problem}
        onVybrat={vyberProblem}
        onZrusit={() => setProblem(null)}
      />

      {problem ? (
        <section aria-labelledby="nadpis-dokumenty" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="nadpis-dokumenty" className="font-semibold">
              Dokumenty z knihovny
            </h2>

            {problem.documents.length > 1 ? (
              <button
                type="button"
                onClick={prepniVse}
                className="min-h-10 px-1 text-sm font-medium text-hlavni underline underline-offset-4"
              >
                {vybraneSablony.length > 0 ? 'Odznačit vše' : 'Vybrat vše'}
              </button>
            ) : null}
          </div>

          {problem.documents.length === 0 ? (
            <p className="text-text-tlumeny">
              K tomuto problému zatím v knihovně žádný dokument není. Pacientovi můžete předat
              samotnou lékařskou zprávu, nebo dokumenty nejdřív nahrajte v knihovně.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {problem.documents.map((dokument) => {
                const vybrany = !odskrtnute.has(dokument.versionId)

                return (
                  <li key={dokument.versionId}>
                    <label
                      className={[
                        'flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 bg-plocha px-4 py-3 transition-colors',
                        vybrany ? 'border-hlavni' : 'border-obrys hover:border-hlavni',
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        checked={vybrany}
                        onChange={() => prepniDokument(dokument.versionId)}
                        className="mt-0.5 h-6 w-6 shrink-0 accent-hlavni"
                      />
                      <span className="min-w-0">
                        <span className="block leading-snug font-medium">{dokument.title}</span>
                        <span className="block text-sm text-text-tlumeny">
                          {stranky(dokument.pageCount)}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : (
        <p className="text-text-tlumeny">
          Vyberte problém a všechny jeho dokumenty se rovnou předvyberou. Co pacient nepotřebuje,
          odškrtnete.
        </p>
      )}

      <Zprava
        key={`zprava-${relace}`}
        zprava={zprava}
        zamceno={predano}
        zajistiBalicek={zajistiBalicek}
        onNahrano={(nova) => {
          setZprava(nova)
          setChyba(null)
        }}
        onStavNahravani={setNahravamZpravu}
        onOdebrat={() => setZprava(null)}
      />

      <div className="max-w-md">
        <Field
          label="Označení pacienta (nepovinné)"
          hint="Pomůže balíček poznat v historii. Ukládá se zašifrovaně a při vypršení platnosti se maže."
        >
          <Input
            value={oznaceni}
            disabled={predano}
            onChange={(event) => setOznaceni(event.target.value)}
            maxLength={MAX_OZNACENI}
            autoComplete="off"
            placeholder="Například Nováková, 14:30"
          />
        </Field>
      </div>

      {chyba ? <Alert tone="chyba">{chyba}</Alert> : null}

      {predano ? (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-uspech/30 bg-uspech/5 px-5 py-4">
          <p className="min-w-0 flex-1 font-medium text-uspech" role="status">
            Balíček je hotový a zapsaný v historii. Pro dalšího pacienta začněte nový.
          </p>
          <Button variant="vedlejsi" type="button" onClick={zacniZnovu}>
            Nový balíček
          </Button>
        </div>
      ) : null}

      <Akce
        key={`akce-${relace}`}
        pripravit={pripravit}
        nastavChybu={setChyba}
        onPredano={() => setPredano(true)}
        pocetDokumentu={predano ? 0 : pocetDokumentu}
        nahravamZpravu={nahravamZpravu}
        souhrn={
          pocetDokumentu > 0 ? `${dokumenty(pocetDokumentu)}, ${stranky(celkemStran)}` : null
        }
      />
    </div>
  )
}

/**
 * Jeden požadavek na rozhraní aplikace.
 *
 * Chyby se vyhazují jako Error s hotovou českou větou, takže volající ji jen
 * zobrazí. Ošetřují se tři různé konce: spadlé spojení (fetch vyhodí),
 * odpověď bez čitelného JSONu (proxy před aplikací umí vrátit vlastní stránku)
 * a chybový stav s hláškou od serveru.
 */
async function odesli<T>(url: string, init: RequestInit): Promise<T> {
  let odpoved: Response
  try {
    odpoved = await fetch(url, init)
  } catch {
    throw new Error(
      'Spojení se serverem se přerušilo. Zkontrolujte prosím připojení a zkuste to znovu.',
    )
  }

  const telo = (await odpoved.json().catch(() => null)) as (T & { error?: string }) | null

  if (!odpoved.ok) throw new Error(telo?.error ?? nahradniChyba(odpoved.status))
  if (!telo) throw new Error('Server odpověděl nesrozumitelně. Zkuste to prosím znovu.')

  return telo
}

/** Když server odpoví bez čitelného těla, musí uživatel dostat aspoň větu. */
function nahradniChyba(status: number): string {
  if (status === 401) return 'Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.'
  if (status === 403) return 'Požadavek server odmítl. Načtěte prosím stránku znovu.'
  if (status === 429) return 'Příliš mnoho požadavků po sobě. Chvíli prosím počkejte.'
  return 'Balíček se nepodařilo uložit. Zkuste to prosím znovu.'
}

function stranky(pocet: number): string {
  if (pocet === 1) return '1 strana'
  if (pocet >= 2 && pocet <= 4) return `${pocet} strany`
  return `${pocet} stran`
}

function dokumenty(pocet: number): string {
  if (pocet === 1) return '1 dokument'
  if (pocet >= 2 && pocet <= 4) return `${pocet} dokumenty`
  return `${pocet} dokumentů`
}
