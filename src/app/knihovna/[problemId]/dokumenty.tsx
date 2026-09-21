'use client'

import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'

import { Alert, Button, Input } from '@/components/ui'
import { moveDocument, renameDocument, setDocumentArchived } from './actions'

/**
 * Ovládání dokumentů v knihovně.
 *
 * Do prohlížeče chodí jen vypsané hodnoty, ne záznamy z databáze – co se
 * dostane do RSC payloadu, to je v prohlížeči čitelné, i kdyby se nikde
 * nevykreslilo.
 *
 * Datum i velikost souboru přicházejí už poskládané ze serveru. Kdyby si je
 * komponenta formátovala sama, použila by zónu a jazyk prohlížeče a po
 * hydrataci by se text lišil od toho, co poslal server.
 */

export type DokumentPolozka = {
  id: string
  title: string
  sortOrder: number
  /** Datum archivace v české podobě, u živého dokumentu null. */
  archivedAt: string | null
  version: number | null
  pageCount: number | null
  currentVersionId: string | null
  /** Hotová řádka „verze 3 · 2 strany · 420 kB · změněno 17. 9. 2026“. */
  popis: string
}

/**
 * Odkaz, který vypadá jako tlačítko.
 *
 * Náhled je navigace, ne akce – musí to být poctivé <a>, aby fungovalo
 * otevření na nové kartě i prostřední tlačítko myši. Button z ui.tsx
 * vykresluje <button>, proto se třídy opisují. Drží se stejného tvaru jako
 * vedlejší tlačítko, aby seznam vypadal jednotně.
 */
const ODKAZ_JAKO_TLACITKO =
  'inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-obrys bg-plocha px-5 text-base font-semibold text-text transition-colors hover:border-hlavni'

/**
 * Počáteční stav si bere tvar rovnou z akce, která bydlí jinde – je to typ
 * jejího prvního parametru. Prázdný objekt tak projde i ve chvíli, kdy stav
 * ponese víc než jen chybovou hlášku.
 */
/**
 * Stejná hodnota jako MAX_FILE_BYTES na serveru. Opisuje se sem, protože
 * src/lib/pdf.ts importuje 'server-only' a do prohlížeče se dostat nesmí.
 */
const MAX_BYTES = 20 * 1024 * 1024

const PRAZDNY_STAV = {} as Parameters<typeof renameDocument>[0]

/**
 * Česká hláška z odpovědi serveru – ze stavu Server Action i z těla, které
 * vrátil route handler pro nahrávání.
 *
 * Čte se opatrně: obojí vzniká v jiném modulu a tahle komponenta se o zbytek
 * jejich polí nestará.
 */
/**
 * Vytáhne ze stavu akce chybu k zobrazení.
 *
 * Čte OBĚ podoby. Server vrací obecnou chybu v `error`, ale chyby vyplnění
 * jednotlivých polí ve `fieldErrors` – a kdyby se četlo jen `error`,
 * formulář by se po odmítnutí názvu zavřel, jako by se uložil, a uživatel
 * by se nedozvěděl vůbec nic.
 */
function chybaZeStavu(stav: unknown): string | null {
  if (!stav || typeof stav !== 'object') return null

  const error = (stav as { error?: unknown }).error
  if (typeof error === 'string' && error.length > 0) return error

  const fieldErrors = (stav as { fieldErrors?: Record<string, unknown> }).fieldErrors
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const hodnota of Object.values(fieldErrors)) {
      if (Array.isArray(hodnota) && typeof hodnota[0] === 'string' && hodnota[0].length > 0) {
        return hodnota[0]
      }
    }
  }

  return null
}

export function Dokumenty({ documents }: { documents: DokumentPolozka[] }) {
  const aktivni = documents.filter((doc) => doc.archivedAt === null)
  const archivovane = documents.filter((doc) => doc.archivedAt !== null)

  // Otevřené přejmenování a rozdělaná archivace se drží tady, ne v každém
  // řádku zvlášť: rozepsaný název a nedokončená otázka mají zmizet, jakmile
  // se obsluha pustí do jiného dokumentu.
  const [upravovanyId, setUpravovanyId] = useState<string | null>(null)
  const [archivovanyId, setArchivovanyId] = useState<string | null>(null)

  // Stabilní odkaz – vnořený formulář si ho drží v efektu, který po uložení
  // zavírá editaci.
  const zavritUpravy = useCallback(() => setUpravovanyId(null), [])

  return (
    <div className="space-y-6">
      {aktivni.length === 0 ? (
        <Alert tone="info">
          Všechny dokumenty tohoto problému jsou archivované. Při přípravě balíčku se žádný
          nenabídne, dokud některý neobnovíte.
        </Alert>
      ) : (
        <ul className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys bg-plocha shadow-sm">
          {aktivni.map((dokument, index) => (
            <li key={dokument.id} className="px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  {upravovanyId === dokument.id ? (
                    <PrejmenovatForm dokument={dokument} onHotovo={zavritUpravy} />
                  ) : (
                    <>
                      <p className="font-medium">
                        {/* Pořadí se ukazuje jako pozice v seznamu, ne jako
                            uložené číslo – to má po archivacích díry a řada
                            1, 2, 4 by vypadala jako chyba. */}
                        <span className="mr-2 text-text-tlumeny tabular-nums">{index + 1}.</span>
                        {dokument.title}
                      </p>
                      <p className="mt-1 text-sm text-text-tlumeny">{dokument.popis}</p>
                    </>
                  )}
                </div>

                {upravovanyId === dokument.id ? null : (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
                    <NahledOdkaz dokument={dokument} />
                    <NovaVerze dokument={dokument} />
                    <Button
                      type="button"
                      variant="nenapadny"
                      onClick={() => {
                        setArchivovanyId(null)
                        setUpravovanyId(dokument.id)
                      }}
                      aria-label={`Přejmenovat dokument ${dokument.title}`}
                    >
                      Přejmenovat
                    </Button>
                    <PosunoutForm
                      dokument={dokument}
                      smer="nahoru"
                      zakazano={index === 0}
                    />
                    <PosunoutForm
                      dokument={dokument}
                      smer="dolu"
                      zakazano={index === aktivni.length - 1}
                    />
                    {archivovanyId === dokument.id ? null : (
                      <Button
                        type="button"
                        variant="nenapadny"
                        onClick={() => {
                          setUpravovanyId(null)
                          setArchivovanyId(dokument.id)
                        }}
                        aria-label={`Archivovat dokument ${dokument.title}`}
                      >
                        Archivovat
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {archivovanyId === dokument.id ? (
                <ArchivovatForm dokument={dokument} onZpet={() => setArchivovanyId(null)} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {archivovane.length > 0 ? (
        <div className="border-t border-obrys pt-6">
          <h3 className="text-sm font-medium uppercase tracking-wide text-text-tlumeny">
            Archivované
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-text-tlumeny">
            Pacientovi se nenabízejí. Zůstávají tu kvůli balíčkům, které je už obsahují, a dají se
            kdykoli vrátit zpátky.
          </p>

          <ul className="mt-4 space-y-4 opacity-70">
            {archivovane.map((dokument) => (
              <li
                key={dokument.id}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium">{dokument.title}</p>
                  <p className="mt-1 text-sm text-text-tlumeny">
                    archivováno {dokument.archivedAt} · {dokument.popis}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
                  <NahledOdkaz dokument={dokument} />
                  {/* Obnovení nic nerozbije, proto jde na jedno klepnutí. */}
                  <form action={setDocumentArchived}>
                    <input type="hidden" name="documentId" value={dokument.id} />
                    <input type="hidden" name="archivovat" value="ne" />
                    <OdeslatTlacitko
                      popisek="Obnovit"
                      probihaPopisek="Obnovuji…"
                      ariaLabel={`Obnovit dokument ${dokument.title}`}
                    />
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Nahrání úplně nového dokumentu do problému.
 *
 * Soubor nesmí jít přes Server Action: ta má strop těla 1 MB a jeho překročení
 * se vyhodí ještě před spuštěním funkce, takže se nedá nahradit srozumitelnou
 * hláškou. Proto fetch na route handler, který si limit hlídá sám.
 */
export function NovyDokument({ problemId, popisek }: { problemId: string; popisek: string }) {
  const { nahravam, chyba, nahrat } = useNahrani()

  return (
    <div className="space-y-3">
      <VyberSouboru
        popisek={popisek}
        probihaPopisek="Nahrávám dokument…"
        variant="hlavni"
        probiha={nahravam}
        onSoubor={(soubor) => {
          const pole = new FormData()
          pole.set('soubor', soubor)
          pole.set('problemId', problemId)
          void nahrat(pole)
        }}
      />
      {chyba ? <Alert>{chyba}</Alert> : null}
    </div>
  )
}

function NovaVerze({ dokument }: { dokument: DokumentPolozka }) {
  const { nahravam, chyba, nahrat } = useNahrani()

  return (
    <>
      <VyberSouboru
        popisek="Nová verze"
        probihaPopisek="Nahrávám…"
        variant="nenapadny"
        probiha={nahravam}
        ariaLabel={`Nahrát novou verzi dokumentu ${dokument.title}`}
        onSoubor={(soubor) => {
          const pole = new FormData()
          pole.set('soubor', soubor)
          pole.set('documentId', dokument.id)
          void nahrat(pole)
        }}
      />
      {chyba ? (
        <p className="w-full text-sm text-chyba" role="alert">
          {chyba}
        </p>
      ) : null}
    </>
  )
}

/**
 * Nahrávání souboru na route handler.
 *
 * Po úspěchu se stránka načte znovu ze serveru: číslo verze, počet stran
 * i velikost počítá až server ze skutečného obsahu, takže se nedají
 * předpovědět dopředu.
 */
function useNahrani() {
  const router = useRouter()
  const [nahravam, setNahravam] = useState(false)
  const [chyba, setChyba] = useState<string | null>(null)
  // Přechod drží tlačítko rozpracované, dokud nedorazí nový seznam. Bez něj by
  // se popisek vrátil do klidu ještě nad starými čísly verzí.
  const [nacitam, spustitNacteni] = useTransition()

  const nahrat = useCallback(
    async (pole: FormData) => {
      setNahravam(true)
      setChyba(null)

      try {
        const odpoved = await fetch('/api/knihovna/nahrat', { method: 'POST', body: pole })

        if (!odpoved.ok) {
          // Server posílá českou větu, která obsluze řekne, co s tím –
          // od „tohle není PDF" po „soubor je moc velký". Vlastní hláška se
          // použije, jen když odpověď nedorazila v očekávaném tvaru.
          const telo: unknown = await odpoved.json().catch(() => null)
          setChyba(chybaZeStavu(telo) ?? 'Dokument se nepodařilo nahrát. Zkuste to prosím znovu.')
          return
        }

        spustitNacteni(() => {
          router.refresh()
        })
      } catch {
        setChyba('Spojení se serverem selhalo. Zkontrolujte připojení a zkuste to znovu.')
      } finally {
        setNahravam(false)
      }
    },
    [router],
  )

  return { nahravam: nahravam || nacitam, chyba, nahrat }
}

/**
 * Tlačítko, které otevře výběr souboru.
 *
 * Nahrání začne hned po výběru. Lékař u pacienta tak klepne dvakrát, ne
 * třikrát – název se vezme ze souboru a přejmenovat se dá kdykoli potom.
 */
function VyberSouboru({
  popisek,
  probihaPopisek,
  variant,
  probiha,
  ariaLabel,
  onSoubor,
}: {
  popisek: string
  probihaPopisek: string
  variant: 'hlavni' | 'vedlejsi' | 'nenapadny'
  probiha: boolean
  ariaLabel?: string
  onSoubor: (soubor: File) => void
}) {
  const vstup = useRef<HTMLInputElement>(null)
  const [prilisVelky, setPrilisVelky] = useState(false)

  return (
    <>
      <input
        ref={vstup}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(udalost) => {
          const soubor = udalost.target.files?.[0]
          // Pole se vyprázdní hned: po neúspěchu chce obsluha často vybrat
          // tentýž soubor znovu a beze změny hodnoty by se událost nespustila.
          udalost.target.value = ''
          if (!soubor) return

          // Velikost se kontroluje i tady, aby se dvacetimegabajtový sken
          // nejdřív dlouze neposílal po ordinační wifi jen proto, aby ho server
          // odmítl. Serveru se tím nic neodebírá – ověřuje si to taky.
          if (soubor.size > MAX_BYTES) {
            setPrilisVelky(true)
            return
          }
          setPrilisVelky(false)
          onSoubor(soubor)
        }}
      />
      <Button
        type="button"
        variant={variant}
        disabled={probiha}
        aria-label={ariaLabel}
        onClick={() => vstup.current?.click()}
      >
        {probiha ? probihaPopisek : popisek}
      </Button>
      {prilisVelky ? (
        <p className="w-full text-sm text-chyba" role="alert">
          Soubor je větší než {MAX_BYTES / 1024 / 1024} MB.
        </p>
      ) : null}
    </>
  )
}

function PrejmenovatForm({
  dokument,
  onHotovo,
}: {
  dokument: DokumentPolozka
  onHotovo: () => void
}) {
  const [stav, akce, probiha] = useActionState(renameDocument, PRAZDNY_STAV)
  const chyba = chybaZeStavu(stav)
  const odeslano = useRef(false)

  // Formulář se zavře až podle odpovědi serveru. Kdyby zmizel hned po
  // odeslání, přišla by obsluha o rozepsaný název ve chvíli, kdy ho server
  // odmítne.
  useEffect(() => {
    if (probiha) {
      odeslano.current = true
      return
    }
    if (odeslano.current && !chyba) {
      odeslano.current = false
      onHotovo()
    }
  }, [probiha, chyba, onHotovo])

  return (
    <form action={akce} className="space-y-3">
      <input type="hidden" name="documentId" value={dokument.id} />

      <Input
        name="nazev"
        defaultValue={dokument.title}
        required
        maxLength={200}
        autoFocus
        aria-label={`Název dokumentu ${dokument.title}`}
      />

      {chyba ? <Alert>{chyba}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <OdeslatTlacitko popisek="Uložit název" probihaPopisek="Ukládám…" variant="vedlejsi" />
        <Button type="button" variant="nenapadny" onClick={onHotovo}>
          Zrušit
        </Button>
      </div>
    </form>
  )
}

function PosunoutForm({
  dokument,
  smer,
  zakazano,
}: {
  dokument: DokumentPolozka
  smer: 'nahoru' | 'dolu'
  zakazano: boolean
}) {
  return (
    <form action={moveDocument}>
      <input type="hidden" name="documentId" value={dokument.id} />
      <input type="hidden" name="smer" value={smer} />
      <OdeslatTlacitko
        popisek={smer === 'nahoru' ? 'Nahoru' : 'Dolů'}
        probihaPopisek="Posouvám…"
        zakazano={zakazano}
        ariaLabel={`Posunout dokument ${dokument.title} ${smer === 'nahoru' ? 'nahoru' : 'dolů'}`}
      />
    </form>
  )
}

/**
 * Archivace se potvrzuje jedním mezikrokem.
 *
 * Na tabletu se o tlačítko v seznamu snadno zavadí palcem při rolování a
 * dokument by pacientovi zmizel z nabídky, aniž by si toho někdo všiml.
 * Obnovení mezikrok nemá – tam se nic neztrácí.
 */
function ArchivovatForm({
  dokument,
  onZpet,
}: {
  dokument: DokumentPolozka
  onZpet: () => void
}) {
  return (
    <form
      action={setDocumentArchived}
      className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border-2 border-varovani/40 bg-varovani/5 px-4 py-3"
    >
      <input type="hidden" name="documentId" value={dokument.id} />
      <input type="hidden" name="archivovat" value="ano" />

      <span className="text-sm">
        Archivovat {dokument.title}? Přestane se nabízet při přípravě balíčku. Pacienti, kteří ho
        už dostali, si ho otevřou dál.
      </span>

      <OdeslatTlacitko popisek="Ano, archivovat" probihaPopisek="Archivuji…" variant="vedlejsi" />

      <Button type="button" variant="nenapadny" onClick={onZpet}>
        Zpět
      </Button>
    </form>
  )
}

/**
 * Tlačítko musí být zvlášť: useFormStatus čte stav formuláře, ve kterém je
 * vnořené. Ve stejné komponentě jako <form> by hlásilo pořád false a šlo by
 * odeslat dvakrát.
 */
function OdeslatTlacitko({
  popisek,
  probihaPopisek,
  variant = 'nenapadny',
  zakazano = false,
  ariaLabel,
}: {
  popisek: string
  probihaPopisek: string
  variant?: 'hlavni' | 'vedlejsi' | 'nenapadny'
  zakazano?: boolean
  ariaLabel?: string
}) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || zakazano}
      aria-label={ariaLabel}
      className="whitespace-nowrap"
    >
      {pending ? probihaPopisek : popisek}
    </Button>
  )
}

/**
 * Odkaz na náhled je schválně napsaný i na stránce, místo aby se importoval
 * odsud. Import z modulu označeného 'use client' by sestře, která nic
 * nespravuje, stáhl do prohlížeče celé tohle ovládání kvůli jedinému odkazu.
 */
function NahledOdkaz({ dokument }: { dokument: DokumentPolozka }) {
  if (!dokument.currentVersionId) {
    return <span className="text-sm text-text-tlumeny">Bez souboru</span>
  }

  return (
    <a
      href={`/api/knihovna/verze/${dokument.currentVersionId}`}
      target="_blank"
      rel="noopener"
      className={ODKAZ_JAKO_TLACITKO}
      aria-label={`Náhled dokumentu ${dokument.title} (otevře se v nové záložce)`}
    >
      Náhled
    </a>
  )
}
