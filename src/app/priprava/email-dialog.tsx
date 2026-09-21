'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'

/**
 * Odeslání balíčku pacientovi e-mailem.
 *
 * Okno má dva kroky a mezi nimi je celý smysl téhle cesty:
 *
 *  1. Adresa pacienta. Odchází v těle požadavku, nikdy v adrese – a e-mail
 *     ponese jen odkaz, žádnou přílohu se zdravotními údaji. Schránka je cizí
 *     úložiště, ke kterému se ordinace už nikdy nedostane.
 *
 *  2. PIN. Server ho vrátí jedinkrát a nikde se neukládá; lékař ho řekne
 *     pacientovi nahlas. Odkaz a kód tak jdou každý jinou cestou a přístup
 *     k samotné schránce k otevření dokumentů nestačí.
 *
 * Z druhého kroku proto nevede žádná nechtěná cesta ven: nezavírá ho klávesa
 * Escape ani kliknutí vedle okna. Zavřít ho jde jen tlačítkem „Hotovo",
 * protože ztracený kód se už vykouzlit nedá a odkaz bez něj je pacientovi
 * k ničemu.
 */

const TVAR_PINU = /^\d{6}$/

type EmailDialogProps = {
  /**
   * Balíček, nad kterým je okno otevřené, nebo null, dokud se poprvé neuložil.
   * Slouží jako pojistka, že se zobrazený PIN týká toho balíčku, který má
   * lékař na obrazovce.
   */
  packageId: string | null
  /** Uloží výběr a vrátí identifikátor balíčku. Při chybě vyhodí českou větu. */
  pripravit: () => Promise<string>
  /** Lékař dočetl kód a zavřel okno. Balíček je od téhle chvíle předaný. */
  onOdeslano: () => void
  /** Zavření bez odeslání. */
  onZavrit: () => void
}

export function EmailDialog({ packageId, pripravit, onOdeslano, onZavrit }: EmailDialogProps) {
  const [adresa, setAdresa] = useState('')
  const [odesilam, setOdesilam] = useState(false)
  const [chyba, setChyba] = useState<string | null>(null)
  const [pin, setPin] = useState<string | null>(null)

  const hotovoRef = useRef<HTMLButtonElement>(null)

  // Po odeslání je na obrazovce jediná podstatná věc – kód. Přesunuté zaměření
  // ho nechá přečíst i odečítači obrazovky a klávesnice nezůstane viset
  // v poli, které mezitím zmizelo.
  useEffect(() => {
    if (pin) hotovoRef.current?.focus()
  }, [pin])

  async function odesli(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    // Dvojí odeslání by založilo druhý odkaz s druhým kódem a pacientovi by
    // přišly dva e-maily. Tlačítko je sice po dobu odesílání nedostupné,
    // ale klávesa Enter v poli formulář odešle znovu.
    if (odesilam || pin) return

    const prijemce = adresa.trim()
    if (!prijemce) {
      setChyba('Zadejte prosím e-mailovou adresu pacienta.')
      return
    }

    setChyba(null)
    setOdesilam(true)

    let id: string
    try {
      id = await pripravit()
    } catch (error) {
      setChyba(
        error instanceof Error && error.message
          ? error.message
          : 'Balíček se nepodařilo připravit. Zkuste to prosím znovu.',
      )
      setOdesilam(false)
      return
    }

    // Rodič mezitím začal nový balíček – odeslat by se tedy poslal jiný obsah,
    // než jaký má lékař před sebou.
    if (packageId !== null && packageId !== id) {
      setChyba('Balíček se mezitím změnil. Zavřete prosím okno a odešlete ho znovu.')
      setOdesilam(false)
      return
    }

    let odpoved: Response
    try {
      odpoved = await fetch(`/api/balicky/${encodeURIComponent(id)}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Adresa pacienta patří do těla požadavku, ne do adresy cesty.
        body: JSON.stringify({ recipient: prijemce }),
      })
    } catch {
      setChyba(
        'Spojení se serverem se přerušilo, e-mail nejspíš neodešel. Zkontrolujte prosím připojení a zkuste to znovu.',
      )
      setOdesilam(false)
      return
    }

    const telo: unknown = await odpoved.json().catch(() => null)

    if (!odpoved.ok) {
      setChyba(chybaZeStavu(telo) ?? nahradniChyba(odpoved.status))
      setOdesilam(false)
      return
    }

    const vraceny = (telo as { pin?: unknown } | null)?.pin
    if (typeof vraceny !== 'string' || !TVAR_PINU.test(vraceny)) {
      // E-mail odešel, ale kód se ztratil – a podruhé ho nikdo nezjistí.
      // Předstírat úspěch by znamenalo poslat pacienta k odkazu, který
      // neotevře.
      setChyba(
        'E-mail odešel, ale kód se nepodařilo zobrazit. Odkaz bez kódu pacient neotevře – zneplatněte ho prosím v historii a odešlete balíček znovu.',
      )
      setOdesilam(false)
      return
    }

    setPin(vraceny)
    setOdesilam(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-text/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nadpis-email"
      onKeyDown={(event) => {
        // V kroku s kódem Escape nedělá nic: zavřené okno by kód vzalo s sebou.
        if (event.key === 'Escape' && !pin && !odesilam) onZavrit()
      }}
    >
      <div className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-plocha p-6 shadow-lg">
        {pin ? (
          <div className="space-y-6 text-center">
            <h2 id="nadpis-email" className="text-2xl font-semibold">
              Řekněte pacientovi tento kód
            </h2>

            {/* Odečítač obrazovky má kód přečíst po číslicích, ne jako číslo. */}
            <p className="sr-only">Kód {[...pin].join(' ')}</p>
            <div aria-hidden="true" className="flex justify-center gap-1.5 sm:gap-3">
              {[...pin].map((znak, poradi) => (
                <span
                  key={poradi}
                  className="flex min-w-10 items-center justify-center rounded-xl border-2 border-obrys bg-podklad px-1 py-4 text-5xl leading-none font-semibold tabular-nums sm:min-w-16 sm:px-3 sm:text-6xl"
                >
                  {znak}
                </span>
              ))}
            </div>

            <p className="text-lg">
              Kód řekněte pacientovi <strong>nahlas</strong>. E-mailem mu ho neposíláme a poslat
              nejde.
            </p>

            <p className="text-text-tlumeny">
              Odkaz a kód jdou schválně každý jinou cestou. Kdo se dostane k pacientově schránce,
              dokumenty bez kódu neotevře.
            </p>

            <Alert tone="info">
              Kód se zobrazuje jen teď. Nikde se neukládá, takže ho později nezjistíme ani my.
            </Alert>

            <Button
              ref={hotovoRef}
              type="button"
              size="velke"
              className="w-full"
              onClick={onOdeslano}
            >
              Hotovo
            </Button>
          </div>
        ) : (
          <form onSubmit={odesli} className="space-y-5">
            <h2 id="nadpis-email" className="text-2xl font-semibold">
              Poslat e-mailem
            </h2>

            <Field
              label="E-mail pacienta"
              hint="Odejde jen odkaz na dokumenty, žádná příloha. Po zadání adresy dostanete kód, který pacientovi řeknete nahlas."
            >
              <Input
                type="email"
                name="prijemce"
                value={adresa}
                onChange={(event) => setAdresa(event.target.value)}
                required
                autoFocus
                // Adresa patří pacientovi, ne lékaři. Prohlížeč ji nemá
                // nabízet dalšímu pacientovi u stejného počítače.
                autoComplete="off"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={254}
                // Ne disabled: zakázané pole ztratí zaměření a lékař by po
                // chybě musel hledat, kam psát.
                readOnly={odesilam}
                placeholder="pacient@example.cz"
              />
            </Field>

            {chyba ? <Alert tone="chyba">{chyba}</Alert> : null}

            {/* Tlačítka jsou tu menší než na hlavní obrazovce: na tabletu
                zabere půlku výšky klávesnice a okno se musí vejít nad ni. */}
            <div className="flex flex-col gap-3 sm:flex-row-reverse">
              <Button type="submit" className="flex-1" disabled={odesilam}>
                {odesilam ? 'Odesílám…' : 'Odeslat'}
              </Button>
              <Button
                type="button"
                variant="vedlejsi"
                className="flex-1"
                onClick={onZavrit}
                disabled={odesilam}
              >
                Zrušit
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
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

/** Když server odpoví bez čitelného těla, musí uživatel dostat aspoň větu. */
function nahradniChyba(status: number): string {
  if (status === 401) return 'Přihlášení vypršelo. Načtěte prosím stránku znovu a přihlaste se.'
  if (status === 429) return 'Příliš mnoho odeslaných e-mailů po sobě. Chvíli prosím počkejte.'
  return 'E-mail se nepodařilo odeslat. Zkuste to prosím znovu, nebo dokumenty vytiskněte.'
}
