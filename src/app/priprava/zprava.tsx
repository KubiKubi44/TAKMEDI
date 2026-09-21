'use client'

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'

import { Alert, Button } from '@/components/ui'

/**
 * Lékařská zpráva přiložená k balíčku.
 *
 * Posílá se na route handler, ne přes Server Action. Ta má strop těla 1 MB a
 * jeho překročení se vyhodí při dekódování ještě PŘED spuštěním funkce – ven
 * by šla holá pětistovka, kterou nejde nahradit srozumitelnou větou. Sken
 * z tabletu bývá klidně několik megabajtů.
 */

/**
 * Stejná hodnota jako MAX_FILE_BYTES na serveru. Opisuje se sem, protože
 * src/lib/pdf.ts importuje 'server-only' a do prohlížeče se dostat nesmí.
 * Kontrola tady je jen ohled na uživatele – rozhoduje vždycky server.
 */
const MAX_BYTES = 20 * 1024 * 1024

/** Co projde bez ptaní. Ostatní typy pošleme serveru, ať rozhodne on. */
const PRIJIMANE = '.pdf,application/pdf,image/jpeg,image/png'

const TLACITKO =
  'inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 ' +
  'border-obrys bg-plocha px-5 text-base font-semibold text-text transition-colors ' +
  'hover:border-hlavni focus-within:border-hlavni'

export type NahranaZprava = {
  uploadedFileId: string
  pageCount: number
  nazev: string
}

type Stav =
  | { druh: 'klid' }
  | { druh: 'nahravam'; nazevSouboru: string }
  | { druh: 'chyba'; text: string }

type ZpravaProps = {
  /**
   * Balíček už byl předaný. Plocha se uzamkne, aby se zpráva DALŠÍHO pacienta
   * nedostala do balíčku toho předchozího – audit i historie by pak lhaly.
   */
  zamceno?: boolean
  /** Hlásí rodiči, že nahrávání běží: tlačítka se tím zablokují. */
  onStavNahravani?: (bezi: boolean) => void
  zprava: NahranaZprava | null
  /**
   * Balíček zakládá rodič, a to líně. Než se zpráva nahraje, musí existovat –
   * nahrané soubory se k němu vážou.
   */
  zajistiBalicek: () => Promise<string>
  onNahrano: (zprava: NahranaZprava) => void
  onOdebrat: () => void
}

export function Zprava({
  zprava,
  zajistiBalicek,
  onNahrano,
  onOdebrat,
  zamceno = false,
  onStavNahravani,
}: ZpravaProps) {
  const [stav, setStav] = useState<Stav>({ druh: 'klid' })
  const [tazeni, setTazeni] = useState(false)
  const [dotykove, setDotykove] = useState(false)

  /*
   * Počítadlo vnoření. dragleave přijde i při přejetí přes vnořený prvek,
   * takže samotný přepínač true/false by plochu rozblikal.
   */
  const hloubkaTazeni = useRef(0)

  /*
   * Fotoaparát má smysl na tabletu a telefonu, kde sestra sken pořídí na
   * místě. Zjišťuje se až po připojení ke stránce: na serveru se druh
   * zařízení zjistit nedá a vykreslit tlačítko rovnou by rozešlo serverovou
   * a klientskou podobu stránky.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    setDotykove(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  const nahravam = stav.druh === 'nahravam'

  useEffect(() => {
    onStavNahravani?.(nahravam)
  }, [nahravam, onStavNahravani])

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

    // Prázdný typ hlásí některé systémy i u platného souboru, proto se
    // odmítá jen to, co je zjevně jinde.
    if (soubor.type && soubor.type !== 'application/pdf' && !soubor.type.startsWith('image/')) {
      setStav({
        druh: 'chyba',
        text: 'Přiložit jde PDF nebo obrázek (JPEG, PNG). Dokument z Wordu nejdřív uložte jako PDF.',
      })
      return
    }

    setStav({ druh: 'nahravam', nazevSouboru: soubor.name })

    let packageId: string
    try {
      packageId = await zajistiBalicek()
    } catch (error) {
      setStav({ druh: 'chyba', text: hlaska(error) })
      return
    }

    const data = new FormData()
    data.set('soubor', soubor)

    let odpoved: Response
    try {
      odpoved = await fetch(`/api/balicky/${packageId}/zprava`, { method: 'POST', body: data })
    } catch {
      setStav({
        druh: 'chyba',
        text: 'Spojení se serverem se přerušilo a zpráva se neuložila. Zkontrolujte prosím připojení a zkuste to znovu.',
      })
      return
    }

    // Odpověď nemusí být JSON: velký soubor umí utnout i proxy před aplikací
    // a ta vrátí vlastní stránku.
    const telo = (await odpoved.json().catch(() => null)) as
      | { error?: string; uploadedFileId?: string; pageCount?: number }
      | null

    if (!odpoved.ok || !telo?.uploadedFileId) {
      setStav({ druh: 'chyba', text: telo?.error ?? nahradniChyba(odpoved.status) })
      return
    }

    setStav({ druh: 'klid' })
    onNahrano({
      uploadedFileId: telo.uploadedFileId,
      pageCount: telo.pageCount ?? 0,
      nazev: soubor.name,
    })
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
    if (nahravam || zamceno) return

    const soubory = event.dataTransfer.files
    if (soubory.length > 1) {
      setStav({
        druh: 'chyba',
        text: 'Najednou jde přiložit jedna zpráva. Přetáhněte prosím jeden soubor.',
      })
      return
    }

    const soubor = soubory.item(0)
    if (soubor) void nahraj(soubor)
  }

  if (zprava) {
    return (
      <section aria-labelledby="nadpis-zprava" className="space-y-3">
        <h2 id="nadpis-zprava" className="sr-only">
          Lékařská zpráva
        </h2>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border-2 border-hlavni bg-hlavni/5 px-5 py-4">
          <p className="min-w-0">
            <span className="block text-sm font-medium tracking-wide text-text-tlumeny uppercase">
              Přiložená zpráva
            </span>
            <span className="block leading-snug font-semibold wrap-break-word">{zprava.nazev}</span>
            <span className="block text-sm text-text-tlumeny">{stranky(zprava.pageCount)}</span>
          </p>

          <Button
            variant="vedlejsi"
            type="button"
            onClick={() => {
              setStav({ druh: 'klid' })
              onOdebrat()
            }}
          >
            Odebrat
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section aria-labelledby="nadpis-zprava" className="space-y-3">
      <h2 id="nadpis-zprava" className="sr-only">
        Lékařská zpráva
      </h2>

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
          'rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-8',
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
            <p className="text-lg font-semibold">Přetáhněte sem lékařskou zprávu</p>
            <p className="mt-1 text-text-tlumeny">Nepovinné – balíček může být i bez ní.</p>

            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <label className={TLACITKO}>
                Vybrat soubor
                <input
                  type="file"
                  accept={PRIJIMANE}
                  onChange={vybranoZDialogu}
                  disabled={nahravam || zamceno}
                  className="sr-only"
                />
              </label>

              {dotykove ? (
                <label className={TLACITKO}>
                  Vyfotit
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={vybranoZDialogu}
                    disabled={nahravam || zamceno}
                    className="sr-only"
                  />
                </label>
              ) : null}
            </div>

            <p className="mt-4 text-sm text-text-tlumeny">
              PDF, fotka nebo sken, nejvýše 20 MB. Fotku převedeme na PDF sami.
            </p>
          </>
        )}
      </div>

      {stav.druh === 'chyba' ? <Alert tone="chyba">{stav.text}</Alert> : null}
    </section>
  )
}

function hlaska(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Zprávu se nepodařilo uložit. Zkuste to prosím znovu.'
}

/** Když server odpoví bez čitelného těla, musí uživatel dostat aspoň větu. */
function nahradniChyba(status: number): string {
  if (status === 413) return 'Soubor je větší než 20 MB a server ho nepřijal.'
  if (status === 401) return 'Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.'
  if (status === 429) return 'Příliš mnoho nahrávání po sobě. Chvíli prosím počkejte.'
  return 'Zprávu se nepodařilo uložit. Zkuste to prosím znovu.'
}

function megabajty(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',')
}

function stranky(pocet: number): string {
  if (pocet === 1) return '1 strana'
  if (pocet >= 2 && pocet <= 4) return `${pocet} strany`
  return `${pocet} stran`
}
