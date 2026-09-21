'use client'

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'

import { Alert } from '@/components/ui'

/**
 * Nahrání dokumentu do knihovny.
 *
 * Posílá se na route handler, ne přes Server Action. Server Actions mají
 * výchozí strop těla 1 MB a jeho překročení se vyhodí při dekódování ještě
 * PŘED spuštěním funkce – ven by šla holá pětistovka, kterou nejde nahradit
 * srozumitelnou větou. Tady se odpověď přečte a ukáže tak, jak přišla.
 */

/**
 * Stejná hodnota jako MAX_FILE_BYTES na serveru. Opisuje se sem, protože
 * src/lib/pdf.ts je server-only a do prohlížeče se importovat nesmí.
 * Kontrola tady je jen ohled na uživatele – rozhoduje vždycky server.
 */
const MAX_BYTES = 20 * 1024 * 1024

/** Co projde bez ptaní. Ostatní typy pošleme serveru, ať rozhodne on. */
const PRIJIMANE = '.pdf,application/pdf,image/jpeg,image/png'

type NahratProps = {
  /** Vlastní popisek nad plochou, když stránka pojmenuje krok po svém. */
  popisek?: string
} & (
  /** Nový dokument v tomhle problému. */
  | { problemId: string; documentId?: never }
  /** Nebo nová verze už existujícího dokumentu. */
  | { documentId: string; problemId?: never }
)

type Stav =
  | { druh: 'klid' }
  | { druh: 'nahravam'; nazevSouboru: string }
  | { druh: 'chyba'; text: string }
  | { druh: 'hotovo'; text: string }

const TLACITKO =
  'inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 ' +
  'border-obrys bg-plocha px-5 text-base font-semibold text-text transition-colors ' +
  'hover:border-hlavni focus-within:border-hlavni'

export function NahratDokument(props: NahratProps) {
  const router = useRouter()
  const [stav, setStav] = useState<Stav>({ druh: 'klid' })
  const [tazeni, setTazeni] = useState(false)

  /*
   * Počítadlo vnoření. dragleave přijde i při přejetí přes vnořený prvek,
   * takže samotný přepínač true/false by plochu rozblikal.
   */
  const hloubkaTazeni = useRef(0)

  const novaVerze = props.documentId !== undefined
  const nahravam = stav.druh === 'nahravam'

  async function nahraj(soubor: File): Promise<void> {
    if (soubor.size === 0) {
      setStav({ druh: 'chyba', text: 'Vybraný soubor je prázdný.' })
      return
    }

    if (soubor.size > MAX_BYTES) {
      setStav({
        druh: 'chyba',
        text:
          `Soubor má ${megabajty(soubor.size)} MB a nahrát jde nejvýše 20 MB. ` +
          'Zkuste ho prosím uložit znovu, například vytisknutím do PDF, nebo ho rozdělte na části.',
      })
      return
    }

    // Do knihovny patří PDF, fotka nebo sken. Prázdný typ hlásí některé
    // systémy i u platného souboru, proto se odmítá jen to, co je zjevně jinde.
    if (soubor.type && soubor.type !== 'application/pdf' && !soubor.type.startsWith('image/')) {
      setStav({
        druh: 'chyba',
        text: 'Nahrát jde PDF nebo obrázek (JPEG, PNG). Dokument z Wordu nejdřív uložte jako PDF.',
      })
      return
    }

    setStav({ druh: 'nahravam', nazevSouboru: soubor.name })

    const data = new FormData()
    data.set('soubor', soubor)
    if (props.documentId) data.set('documentId', props.documentId)
    else if (props.problemId) data.set('problemId', props.problemId)

    let odpoved: Response
    try {
      odpoved = await fetch('/api/knihovna/nahrat', { method: 'POST', body: data })
    } catch {
      setStav({
        druh: 'chyba',
        text: 'Spojení se serverem se přerušilo a soubor se neuložil. Zkontrolujte prosím připojení a zkuste to znovu.',
      })
      return
    }

    // Odpověď nemusí být JSON: velký soubor umí utnout i proxy před aplikací
    // a ta vrátí vlastní stránku.
    const telo = (await odpoved.json().catch(() => null)) as
      | { error?: string; version?: number; pageCount?: number }
      | null

    if (!odpoved.ok) {
      setStav({ druh: 'chyba', text: telo?.error ?? nahradniChyba(odpoved.status) })
      return
    }

    const pocetStran = stranky(telo?.pageCount ?? 0)

    setStav({
      druh: 'hotovo',
      text: novaVerze
        ? `Hotovo. Nahráno jako verze ${telo?.version ?? 1}, ${pocetStran}. Dříve předané balíčky zůstávají na původní verzi.`
        : `Hotovo. Dokument „${soubor.name}“ je v knihovně, ${pocetStran}.`,
    })

    router.refresh()
  }

  function vybranoZDialogu(event: ChangeEvent<HTMLInputElement>): void {
    const soubor = event.target.files?.[0]
    // Vyprázdnění vstupu dovolí vybrat po chybě týž soubor znovu.
    event.target.value = ''
    if (soubor) void nahraj(soubor)
  }

  function pretazeno(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    hloubkaTazeni.current = 0
    setTazeni(false)
    if (nahravam) return

    const soubory = event.dataTransfer.files
    if (soubory.length > 1) {
      setStav({
        druh: 'chyba',
        text: 'Najednou jde nahrát jeden soubor. Přetáhněte je prosím po jednom.',
      })
      return
    }

    const soubor = soubory.item(0)
    if (soubor) void nahraj(soubor)
  }

  return (
    <div className="space-y-3">
      <div
        aria-busy={nahravam}
        onDragEnter={(event) => {
          event.preventDefault()
          hloubkaTazeni.current += 1
          setTazeni(true)
        }}
        // Bez zrušení výchozího chování prohlížeč soubor místo předání otevře.
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          hloubkaTazeni.current -= 1
          if (hloubkaTazeni.current <= 0) {
            hloubkaTazeni.current = 0
            setTazeni(false)
          }
        }}
        onDrop={pretazeno}
        className={[
          'rounded-2xl border-2 border-dashed p-6 text-center transition-colors',
          novaVerze ? 'sm:p-6' : 'sm:p-8',
          tazeni ? 'border-hlavni bg-hlavni/5' : 'border-obrys bg-plocha',
          nahravam ? 'opacity-70' : '',
        ].join(' ')}
      >
        {stav.druh === 'nahravam' ? (
          <p className="font-semibold" role="status">
            Nahrávám… <span className="font-normal text-text-tlumeny">{stav.nazevSouboru}</span>
          </p>
        ) : (
          <>
            <p className="font-semibold">
              {props.popisek ?? (novaVerze ? 'Nahrát novou verzi' : 'Přidat dokument')}
            </p>
            <p className="mt-1 text-text-tlumeny">Přetáhněte sem soubor, nebo ho vyberte.</p>

            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <label className={TLACITKO}>
                Vybrat soubor
                <input
                  type="file"
                  accept={PRIJIMANE}
                  onChange={vybranoZDialogu}
                  disabled={nahravam}
                  className="sr-only"
                />
              </label>

              {/* Na tabletu se sken pořídí rovnou fotoaparátem. */}
              <label className={TLACITKO}>
                Vyfotit
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={vybranoZDialogu}
                  disabled={nahravam}
                  className="sr-only"
                />
              </label>
            </div>

            <p className="mt-4 text-sm text-text-tlumeny">
              PDF, fotka nebo sken, nejvýše 20 MB. Fotku převedeme na PDF sami.
              {novaVerze ? ' Původní verze zůstane u dříve předaných balíčků.' : ''}
            </p>
          </>
        )}
      </div>

      {stav.druh === 'chyba' ? <Alert tone="chyba">{stav.text}</Alert> : null}
      {stav.druh === 'hotovo' ? <Alert tone="uspech">{stav.text}</Alert> : null}
    </div>
  )
}

/** Když server odpoví bez čitelného těla, musí uživatel dostat aspoň větu. */
function nahradniChyba(status: number): string {
  if (status === 413) return 'Soubor je větší než 20 MB a server ho nepřijal.'
  if (status === 403) return 'K úpravám knihovny nemáte oprávnění.'
  if (status === 401) return 'Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.'
  return 'Dokument se nepodařilo uložit. Zkuste to prosím znovu.'
}

function megabajty(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',')
}

function stranky(pocet: number): string {
  if (pocet === 1) return '1 strana'
  if (pocet >= 2 && pocet <= 4) return `${pocet} strany`
  return `${pocet} stran`
}
