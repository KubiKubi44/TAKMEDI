'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Alert, Button, Field, Input } from '@/components/ui'
import { createTag, revokeTag, type CreateTagState } from './actions'

/**
 * Formuláře pro správu NFC čipu.
 *
 * Do prohlížeče odsud jde jen to, co obsluha opravdu vidí: popis čipu a po
 * vytvoření jednou jeho adresa. Žádný záznam z databáze se sem nepředává –
 * co se dostane do RSC payloadu, to je v prohlížeči čitelné, i kdyby se to
 * nikde nevykreslilo.
 */

export function NovyCip() {
  const [state, action, isPending] = useActionState<CreateTagState, FormData>(createTag, {})

  // Adresa zmizí, až ji správce odklikne. Stav akce si Next drží i po dalším
  // vykreslení stránky, proto se schovaný panel pozná podle čipu, ke kterému
  // patřil – po vytvoření dalšího se objeví znovu.
  const [odklikleId, setOdklikleId] = useState<string | null>(null)
  const vytvoreny = state.created && state.created.id !== odklikleId ? state.created : null

  if (vytvoreny) {
    return (
      <Adresa
        label={vytvoreny.label}
        url={vytvoreny.url}
        onHotovo={() => setOdklikleId(vytvoreny.id)}
      />
    )
  }

  return (
    <form action={action} className="space-y-5">
      {state.error ? <Alert>{state.error}</Alert> : null}

      <Field
        label="Popis čipu"
        hint="Podle čeho čip poznáte, až jich bude víc. Například „Čip u recepce“ nebo „Nálepka na stole v ordinaci“."
        errors={state.fieldErrors?.label}
      >
        <Input name="label" autoComplete="off" required maxLength={120} />
      </Field>

      <p className="max-w-2xl text-sm text-text-tlumeny">
        Adresu k zápisu uvidíte hned po vytvoření, a naposledy. Než kliknete, mějte prosím po ruce
        telefon s aplikací na zápis NFC a nálepku – kroky 1 a 2 návodu výše.
      </p>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Vytvářím čip…' : 'Vytvořit čip'}
      </Button>
    </form>
  )
}

type AdresaProps = {
  label: string
  url: string
  onHotovo: () => void
}

/**
 * Adresa nového čipu.
 *
 * Schválně to NENÍ odkaz. Adresa obsahuje tajemství čipu a kliknutí by ji
 * uložilo do historie prohlížeče, odkud se často synchronizuje do cloudu –
 * a tajemství patří na nálepku, ne na čtyři další zařízení. Ověřuje se
 * přiložením telefonu, ne kliknutím.
 */
function Adresa({ label, url, onHotovo }: AdresaProps) {
  const [stav, setStav] = useState<'klid' | 'zkopirovano' | 'rucne'>('klid')
  const poleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (stav !== 'rucne') return
    const pole = poleRef.current
    if (!pole) return
    pole.focus()
    pole.select()
  }, [stav])

  async function zkopiruj(): Promise<void> {
    try {
      /*
       * Schránka nemusí existovat: prohlížeč ji nabízí jen v zabezpečeném
       * kontextu, tedy přes HTTPS nebo na localhostu. Na ordinačním tabletu
       * otevřeném po IP adrese tedy navigator.clipboard vůbec není a přístup
       * k writeText vyhodí výjimku ještě před await – ošetří ji stejný catch
       * jako odmítnutý zápis.
       */
      await navigator.clipboard.writeText(url)
      setStav('zkopirovano')
    } catch {
      setStav('rucne')
    }
  }

  return (
    <div className="space-y-5">
      <Alert tone="uspech">Čip „{label}“ je vytvořený. Zbývá zapsat adresu na nálepku.</Alert>

      <div className="rounded-xl border-2 border-varovani/50 bg-varovani/5 p-5">
        <p className="mb-1 font-medium">Adresa k zápisu na čip</p>
        <p className="mb-3 text-sm text-text-tlumeny">
          Zobrazuje se jen teď. Nikam se neukládá a znovu ji nezobrazí nikdo, ani my.
        </p>

        <p className="font-mono text-xl leading-snug font-bold break-all select-all sm:text-2xl">
          {url}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" variant="vedlejsi" onClick={zkopiruj}>
            Zkopírovat
          </Button>
          {stav === 'zkopirovano' ? (
            <span role="status" className="text-sm font-medium text-uspech">
              Adresa je ve schránce.
            </span>
          ) : null}
        </div>

        {stav === 'rucne' ? (
          <div className="mt-4">
            <p role="status" className="mb-1.5 text-sm text-text-tlumeny">
              Schránka v tomhle prohlížeči není k dispozici. Text je označený – zkopírujte ho
              klávesami Ctrl+C, na Macu Cmd+C.
            </p>
            <Input
              ref={poleRef}
              readOnly
              value={url}
              aria-label="Adresa k zápisu na čip"
              className="font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : null}
      </div>

      <div className="max-w-2xl space-y-3 text-sm text-text-tlumeny">
        <p>
          <strong className="font-semibold text-text">Adresu si neukládejte.</strong> Nepatří do
          e-mailu, do sdíleného dokumentu ani na leták pro pacienty – patří jedině na nálepku. Kdo
          ji zná, dostane se k zadání čtyřmístného kódu odkudkoli na světě, bez toho, aby stál ve
          vaší ordinaci.
        </p>
        <p>
          <strong className="font-semibold text-text">Proč je v adrese ta dlouhá změť znaků.</strong>{' '}
          Je to tajemství čipu. Kód, který pacient opisuje z obrazovky, má jen čtyři číslice, aby
          se dal rychle a bez chyby přečíst. Kdyby adresa čipu žádné tajemství neobsahovala,
          mohl by se na pole pro kód dostat kdokoli a zkoušet ho uhodnout. Takhle se k němu dostane
          jen ten, kdo telefon fyzicky přiložil k vaší nálepce.
        </p>
        <p>
          Když adresu ztratíte dřív, než ji stihnete zapsat, nic se neděje: vytvořte čip znovu a
          ten nepoužitý odvolejte.
        </p>
      </div>

      <Button variant="vedlejsi" onClick={onHotovo}>
        Mám adresu zapsanou, skrýt
      </Button>
    </div>
  )
}

/**
 * Odvolání čipu.
 *
 * Potvrzuje se, protože je to nevratné a v ordinaci nepůjde napravit softwarově:
 * zamčenou nálepku nejde přepsat, musí se slupnout a nalepit nová. Na tabletu
 * se přitom o tlačítko v tabulce snadno zavadí palcem při rolování.
 */
export function OdvolatCip({ tagId, label }: { tagId: string; label: string }) {
  const [ptamSe, setPtamSe] = useState(false)

  if (!ptamSe) {
    return (
      <Button
        type="button"
        variant="vedlejsi"
        className="whitespace-nowrap"
        onClick={() => setPtamSe(true)}
        aria-label={`Odvolat čip ${label}`}
      >
        Odvolat
      </Button>
    )
  }

  return (
    <form action={revokeTag} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="tagId" value={tagId} />

      <span className="text-sm text-text-tlumeny">
        Odvolat čip „{label}“? Přestane fungovat okamžitě – po přiložení telefonu se pacientovi
        neotevře nic. Nálepku už nepůjde oživit, budete muset zapsat novou.
      </span>

      <OdvolatTlacitko />

      <Button type="button" variant="nenapadny" onClick={() => setPtamSe(false)}>
        Zpět
      </Button>
    </form>
  )
}

/**
 * Tlačítko musí být zvlášť: useFormStatus čte stav formuláře, ve kterém je
 * vnořené, takže ve stejné komponentě jako <form> by hlásilo pořád false
 * a odvolání by šlo odeslat dvakrát.
 */
function OdvolatTlacitko() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="vedlejsi" className="whitespace-nowrap" disabled={pending}>
      {pending ? 'Odvolávám…' : 'Ano, odvolat'}
    </Button>
  )
}
