'use client'

import { useActionState } from 'react'

import { Alert, Button, Field, Input } from '@/components/ui'

import { verify, type OvereniStav } from './actions'

/**
 * Ověření u odkazu, který přišel e-mailem.
 *
 * Odkaz a odpověď na tuhle otázku chodí každý jinou cestou: odkaz e-mailem,
 * šest číslic řekne lékař nahlas v ordinaci. Kdo se dostane jen k cizímu
 * e-mailu, se tedy k dokumentům nedostane.
 *
 * Formulář je obyčejný a odesílá se přes atribut action, takže projde i bez
 * JavaScriptu. Stav z useActionState jen zpřesňuje chování v prohlížeči.
 *
 * Co tu schválně NENÍ: cokoli o ordinaci, o dokumentech a o jejich počtu.
 * Ověření má vpustit dovnitř, ne prozradit, co je uvnitř.
 */

const VYCHOZI_STAV: OvereniStav = {}

export function Overeni({ token, zpusob }: { token: string; zpusob: 'PIN' | 'DOB' }) {
  const [stav, akce, probiha] = useActionState(verify, VYCHOZI_STAV)

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Ještě se ujistíme, že jsme u správného člověka</h1>
        <p className="text-lg">
          Za odkazem jsou dokumenty o vašem zdraví. Než je ukážeme, ověříme si, že ho otevřel ten,
          komu patří – e-mail se občas dostane i tam, kam neměl.
        </p>
      </header>

      <form
        action={akce}
        className="space-y-5 rounded-2xl border border-obrys bg-plocha p-6 shadow-sm"
      >
        {/*
          Token nese formulář, protože Server Action se na adresu stránky
          zeptat nemůže. Dál než sem se nedostane: nikde se nevypisuje,
          neputuje do odkazu ven ani do chybové hlášky.
        */}
        <input type="hidden" name="token" value={token} />

        {stav.error ? <Alert tone="chyba">{stav.error}</Alert> : null}

        {zpusob === 'PIN' ? <PoleSCislicemi chyba={Boolean(stav.error)} /> : <PoleSDatem />}

        <Button type="submit" className="w-full" size="velke" disabled={probiha}>
          {probiha ? 'Kontroluji…' : 'Zobrazit dokumenty'}
        </Button>
      </form>

      <p className="text-text-tlumeny">
        Nevíte si rady? Zavolejte do ordinace, kde jste dokumenty dostali.{' '}
        {zpusob === 'PIN'
          ? 'Číslice vám řeknou znovu, nebo vám pošlou nový odkaz.'
          : 'Poradí vám, nebo vám pošlou nový odkaz.'}
      </p>
    </div>
  )
}

/**
 * Šest číslic, které lékař řekl pacientovi.
 *
 * Dvě rozhodnutí, která vypadají jako opomenutí:
 *
 * Pole se po nezdaru NEMAŽE. Na rozdíl od kódu z ověřovací aplikace tenhle
 * údaj nezastarává, takže je nejspíš jen překlepnutý – pacient ho má opravit,
 * ne psát znovu celý.
 *
 * Není tu ani atribut pattern. Prohlížeč by odeslání zastavil vlastní hláškou
 * („Použijte požadovaný formát"), ze které se pacient nedozví, co má udělat.
 * Server odpoví celou větou a mezery mezi číslicemi si srovná sám.
 */
function PoleSCislicemi({ chyba }: { chyba: boolean }) {
  return (
    <Field label="Šest číslic od lékaře" hint="Řekl vám je v ordinaci. V e-mailu s odkazem nejsou.">
      <Input
        name="pin"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        required
        spellCheck={false}
        aria-invalid={chyba ? true : undefined}
        // Vykřičník u velikosti písma musí být: Tailwind řadí utility stejné
        // vlastnosti podle abecedy, takže text-base ze sdíleného pole by jinak
        // vyhrálo nad text-3xl bez ohledu na pořadí tříd.
        className="py-4 text-center text-3xl! font-semibold tracking-[0.4em] indent-[0.4em]"
      />
    </Field>
  )
}

/**
 * Datum narození ve třech polích, ne v <input type="date">.
 *
 * Rozhoduje o tom, komu je stránka určená. Vestavěný výběr data se v telefonu
 * otevře na dnešním roce a k roku 1948 se pacient dostane dlouhým otáčením
 * kolečka – nejhůř právě ti nejstarší. Druhá věc je pořadí: type="date"
 * ukazuje datum v podobě, kterou určuje nastavení telefonu, takže z pole není
 * poznat, jestli je vepředu den, nebo měsíc. Tři popsaná políčka to říkají
 * nahlas, rovnou vyvolají číselnou klávesnici a fungují i bez JavaScriptu.
 * Do jednoho tvaru se datum složí až na serveru, aby o něm rozhodovalo jediné
 * místo.
 *
 * Bez zástupného textu v polích schválně: v prázdném políčku se dá splést
 * s vyplněnou hodnotou a při psaní zmizí. Co je potřeba vědět, stojí ve větě
 * nad nimi.
 */
function PoleSDatem() {
  return (
    <fieldset>
      <legend className="block font-medium">Datum narození</legend>
      <p className="mt-1.5 text-sm text-text-tlumeny">
        Datum narození toho, komu jsou dokumenty určené. Rok napište celý, třeba 1948.
      </p>

      <div className="mt-3 grid grid-cols-[1fr_1fr_1.4fr] gap-3">
        <Field label="Den">
          <Input
            name="den"
            type="text"
            inputMode="numeric"
            autoComplete="bday-day"
            maxLength={2}
            required
            className="text-center"
          />
        </Field>

        <Field label="Měsíc">
          <Input
            name="mesic"
            type="text"
            inputMode="numeric"
            autoComplete="bday-month"
            maxLength={2}
            required
            className="text-center"
          />
        </Field>

        <Field label="Rok">
          <Input
            name="rok"
            type="text"
            inputMode="numeric"
            autoComplete="bday-year"
            maxLength={4}
            required
            className="text-center"
          />
        </Field>
      </div>
    </fieldset>
  )
}
