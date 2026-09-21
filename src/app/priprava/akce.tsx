'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Alert, Button } from '@/components/ui'
import { Kod } from '@/app/predani/[activationId]/kod'
import { EmailDialog } from './email-dialog'

/**
 * Tři způsoby, jak balíček předat pacientovi.
 *
 * Hotový je zatím tisk. NFC a e-mail se staví v dalších etapách; jejich
 * tlačítka jsou tu vidět, ale nedostupná a s vysvětlením – mrtvé tlačítko,
 * které po kliknutí neudělá nic, je horší než tlačítko, o kterém se rovnou ví,
 * že ještě nefunguje.
 */

/**
 * Po téhle době bez události load se tiskový dialog už nečeká.
 *
 * Sloučení většího balíčku běží na serveru v odděleném vlákně a nějakou chvíli
 * trvá; samotné zobrazení hotového PDF v rámu je pak otázka okamžiku.
 */
const CEKANI_NA_RAM_MS = 20_000

type AkceProps = {
  /** Uloží výběr a vrátí identifikátor balíčku. Při chybě vyhodí českou větu. */
  pripravit: () => Promise<string>
  nastavChybu: (text: string | null) => void
  onPredano: () => void
  pocetDokumentu: number
  /**
   * Právě běží nahrávání lékařské zprávy.
   *
   * Bez tohohle by šlo kliknout na Vytisknout uprostřed nahrávání šestimegového
   * skenu a pacient by dostal balíček BEZ zprávy – přitom obrazovka by tvrdila,
   * že je hotovo.
   */
  nahravamZpravu: boolean
  /** Hotová řádka „3 dokumenty, 7 stran“, nebo null, když není co předat. */
  souhrn: string | null
}

export function Akce({
  pripravit,
  nastavChybu,
  onPredano,
  pocetDokumentu,
  souhrn,
  nahravamZpravu,
}: AkceProps) {
  const [pripravuji, setPripravuji] = useState(false)
  /**
   * Běžící předání přes čip.
   *
   * Kód se drží TADY, v paměti komponenty, a nikam se neukládá ani neposílá
   * v adrese: platí tři minuty a v databázi je z něj jen HMAC. Modální okno
   * je proto lepší než samostatná stránka – při přechodu na stránku by se
   * musel kód někam odložit.
   */
  const [emailOtevreno, setEmailOtevreno] = useState(false)
  const [predani, setPredani] = useState<{
    activationId: string
    code: string
    expiresAt: string
  } | null>(null)
  const [odkazNaPdf, setOdkazNaPdf] = useState<string | null>(null)
  const [poznamka, setPoznamka] = useState<string | null>(null)

  const ramRef = useRef<HTMLIFrameElement>(null)
  const odkazRef = useRef<string | null>(null)
  const casovacRef = useRef<number | null>(null)

  const lzePredat = pocetDokumentu > 0 && !nahravamZpravu

  const uvolniOdkaz = useCallback(() => {
    if (odkazRef.current) {
      URL.revokeObjectURL(odkazRef.current)
      odkazRef.current = null
    }
    setOdkazNaPdf(null)
  }, [])

  useEffect(
    () => () => {
      uvolniOdkaz()
      // Časovač by po odpojení komponenty sáhl na stav, který už neexistuje –
      // a rodič ji odpojuje hned po předání, když lékař klikne na „Nový balíček".
      if (casovacRef.current !== null) window.clearTimeout(casovacRef.current)
    },
    [uvolniOdkaz],
  )

  /**
   * Záložní cesta: PDF na nové záložce.
   *
   * Vyskakovací okno umí prohlížeč zablokovat, protože se otevírá až po
   * návratu ze sítě, tedy mimo přímou reakci na kliknutí. Pak zbývá odkaz,
   * na který uživatel klikne sám – ten projde vždycky.
   */
  const zaloha = useCallback(
    (url: string) => {
      setPripravuji(false)

      // Bez příznaku 'noopener' v řetězci vlastností: s ním vrací window.open
      // podle specifikace VŽDY null, i když se záložka opravdu otevřela, a
      // rozpoznat úspěch od zablokovaného okna by pak nešlo. Odkaz na opener
      // se zahazuje ručně hned potom.
      const okno = window.open(url, '_blank')
      if (okno) {
        try {
          okno.opener = null
        } catch {
          // Některé prohlížeče zápis zakazují. Jde o adresu blob: ze stejného
          // původu, takže se tím nic neztrácí.
        }
        setPoznamka(
          'Tiskový dialog se otevřít nepodařilo, PDF jsme proto otevřeli na nové záložce. Vytiskněte ho prosím odtamtud.',
        )
        return
      }

      nastavChybu(
        'Tiskový dialog ani nová záložka se neotevřely – prohlížeč je nejspíš zablokoval. Otevřete prosím PDF odkazem níže.',
      )
    },
    [nastavChybu],
  )

  /**
   * Otevření tiskového dialogu nad sloučeným PDF.
   *
   * PDF se nejdřív stáhne a teprve pak zobrazí z adresy blob:. Přímé
   * `src="/api/balicky/…/tisk.pdf"` by NEFUNGOVALO: aplikace posílá na všechny
   * cesty hlavičku X-Frame-Options: DENY (next.config.ts), takže by prohlížeč
   * vložení do rámu odmítl. Obsah z blob: adresy žádné hlavičky nemá a pravidlo
   * frame-src v CSP ho výslovně povoluje.
   *
   * Vedlejší zisk: chybovou odpověď serveru jde přečíst a ukázat jako větu,
   * místo aby se v rámu mlčky objevila prázdná stránka.
   */
  function otevriTiskovyDialog(url: string): void {
    const ram = ramRef.current
    if (!ram) {
      zaloha(url)
      return
    }

    let vyrizeno = false

    const casovac = window.setTimeout(() => {
      if (vyrizeno) return
      vyrizeno = true
      zaloha(url)
    }, CEKANI_NA_RAM_MS)
    casovacRef.current = casovac

    ram.onload = () => {
      if (vyrizeno) return
      vyrizeno = true
      window.clearTimeout(casovac)
      casovacRef.current = null

      try {
        ram.contentWindow?.focus()
        ram.contentWindow?.print()
      } catch {
        zaloha(url)
        return
      }

      setPripravuji(false)
      setPoznamka('Tiskový dialog je otevřený v prohlížeči.')
    }

    ram.src = url
  }

  async function predatPresNfc(): Promise<void> {
    if (pripravuji) return

    nastavChybu(null)
    setPoznamka(null)
    setPripravuji(true)

    let packageId: string
    try {
      packageId = await pripravit()
    } catch (error) {
      nastavChybu(hlaska(error))
      setPripravuji(false)
      return
    }

    try {
      const odpoved = await fetch('/api/predani/aktivovat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId }),
      })

      const telo: unknown = await odpoved.json().catch(() => null)

      if (!odpoved.ok) {
        nastavChybu(
          chybaZeStavu(telo) ?? 'Předání se nepodařilo spustit. Zkuste to prosím znovu.',
        )
        return
      }

      const data = telo as { activationId: string; code: string; expiresAt: string }
      setPredani(data)
    } catch {
      nastavChybu(
        'Spojení se serverem se přerušilo. Zkontrolujte prosím připojení a zkuste to znovu.',
      )
    } finally {
      setPripravuji(false)
    }
  }

  async function vytiskni(): Promise<void> {
    if (pripravuji) return

    nastavChybu(null)
    setPoznamka(null)
    uvolniOdkaz()
    setPripravuji(true)

    let packageId: string
    try {
      packageId = await pripravit()
    } catch (error) {
      nastavChybu(hlaska(error))
      setPripravuji(false)
      return
    }

    let odpoved: Response
    try {
      odpoved = await fetch(`/api/balicky/${packageId}/tisk.pdf`)
    } catch {
      nastavChybu(
        'Spojení se serverem se přerušilo a PDF se nestáhlo. Zkontrolujte prosím připojení a zkuste to znovu.',
      )
      setPripravuji(false)
      return
    }

    if (!odpoved.ok) {
      // Tahle cesta vrací chybu jako prostý text, ne JSON.
      const text = (await odpoved.text().catch(() => '')).trim()
      nastavChybu(odpoved.status === 404 || !text ? nahradniChyba(odpoved.status) : text)
      setPripravuji(false)
      return
    }

    let url: string
    try {
      url = URL.createObjectURL(await odpoved.blob())
    } catch {
      nastavChybu('Stažené PDF se nepodařilo otevřít. Zkuste to prosím znovu.')
      setPripravuji(false)
      return
    }

    odkazRef.current = url
    setOdkazNaPdf(url)

    /*
     * Od téhle chvíle je balíček předaný: server ho sloučil a zapsal do
     * auditu jako vytištěný. Rodič na to čeká, aby dalšího pacienta založil
     * jako nový balíček a tenhle už nikdo nepřepsal.
     */
    onPredano()

    otevriTiskovyDialog(url)
  }

  return (
    <section aria-labelledby="nadpis-akce" className="space-y-3">
      <h2 id="nadpis-akce" className="sr-only">
        Předání pacientovi
      </h2>

      {lzePredat ? null : (
        <p className="text-text-tlumeny">
          Nejdřív vyberte aspoň jeden dokument nebo přiložte lékařskou zprávu.
        </p>
      )}

      {predani ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Předání přes NFC"
        >
          <div className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-plocha p-6 shadow-lg">
            <Kod
              key={predani.activationId}
              activationId={predani.activationId}
              expiresAt={predani.expiresAt}
              stav="ACTIVE"
              kod={predani.code}
              onHotovo={() => {
                setPredani(null)
                onPredano()
              }}
              onZkusitZnovu={() => {
                // Okno se zavře a rozdělaný balíček na obrazovce zůstane,
                // takže lékař jen znovu klikne. Návrat na jinou stránku by
                // výběr dokumentů i nahranou zprávu zahodil.
                setPredani(null)
              }}
            />
          </div>
        </div>
      ) : null}

      {emailOtevreno ? (
        // Okno si překryv vykresluje samo – na rozdíl od Kod se neobaluje.
        <EmailDialog
          packageId={null}
          pripravit={pripravit}
          onOdeslano={() => {
            setEmailOtevreno(false)
            onPredano()
          }}
          onZavrit={() => setEmailOtevreno(false)}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Button
            type="button"
            variant="vedlejsi"
            size="velke"
            className="w-full"
            onClick={predatPresNfc}
            disabled={!lzePredat || pripravuji}
            aria-describedby="popis-nfc"
          >
            {pripravuji ? 'Připravuji…' : 'Předat přes NFC'}
          </Button>
          <p id="popis-nfc" className="text-sm text-text-tlumeny">
            Pacient přiloží telefon k čipu a opíše kód z obrazovky.
          </p>
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            variant="hlavni"
            size="velke"
            className="w-full"
            onClick={vytiskni}
            disabled={!lzePredat || pripravuji}
            aria-describedby="popis-tisk"
          >
            {pripravuji ? 'Připravuji tisk…' : 'Vytisknout'}
          </Button>
          <p id="popis-tisk" className="text-sm text-text-tlumeny">
            {souhrn ? `${souhrn} v jednom PDF.` : 'Sloučí vybrané dokumenty do jednoho PDF.'}
          </p>
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            variant="vedlejsi"
            size="velke"
            className="w-full"
            onClick={() => {
              nastavChybu(null)
              setPoznamka(null)
              setEmailOtevreno(true)
            }}
            disabled={!lzePredat || pripravuji}
            aria-describedby="popis-email"
          >
            Poslat e-mailem
          </Button>
          <p id="popis-email" className="text-sm text-text-tlumeny">
            Pacientovi odejde jen odkaz. Kód mu řeknete nahlas.
          </p>
        </div>
      </div>

      {poznamka ? <Alert tone="info">{poznamka}</Alert> : null}

      {odkazNaPdf ? (
        <p className="text-sm">
          <a
            href={odkazNaPdf}
            target="_blank"
            rel="noopener"
            className="font-medium text-hlavni underline underline-offset-4"
          >
            Otevřít sloučené PDF na nové záložce
          </a>
        </p>
      ) : null}

      {/*
        Rám musí zůstat v rozvržení, jen mimo dohled. Prohlížeč pro obsah
        schovaný přes display:none nemusí spustit prohlížeč PDF, a pak není
        co tisknout.
      */}
      <iframe
        ref={ramRef}
        title="Balíček k tisku"
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none fixed right-0 bottom-0 h-px w-px border-0 opacity-0"
      />
    </section>
  )
}

/** Vytáhne českou větu z chybové odpovědi rozhraní, když v ní je. */
function chybaZeStavu(telo: unknown): string | null {
  if (telo && typeof telo === 'object' && 'error' in telo) {
    const text = (telo as { error?: unknown }).error
    if (typeof text === 'string' && text.length > 0) return text
  }
  return null
}

function hlaska(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Balíček se nepodařilo připravit. Zkuste to prosím znovu.'
}

/** Když server odpoví bez čitelného těla, musí uživatel dostat aspoň větu. */
function nahradniChyba(status: number): string {
  if (status === 404) return 'Balíček se nepodařilo najít. Načtěte prosím stránku znovu.'
  if (status === 401) return 'Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.'
  return 'PDF k tisku se nepodařilo připravit. Zkuste to prosím znovu.'
}
