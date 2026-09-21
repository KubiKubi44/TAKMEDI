'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Alert, Button, Field, Input } from '@/components/ui'
import {
  type CreateUserState,
  type ObnovaState,
  type PracticeState,
  createUser,
  resetUserPassword,
  resetUserTotp,
  setUserStatus,
  updatePractice,
} from './actions'

/** Výchozí stav obou akcí obnovy přístupu. */
const PRAZDNY_OBNOVA_STAV: ObnovaState = {}

/**
 * Formuláře nastavení, které potřebují stav odpovědi ze serveru.
 *
 * Obojí je tady záměrně pohromadě: jsou to jediné dvě klientské komponenty
 * téhle části a obě dělají totéž – odešlou Server Action a vykreslí, co vrátí.
 *
 * Do prohlížeče se odsud posílají jen vypsané hodnoty (název ordinace, čísla,
 * jméno a e-mail nového uživatele). Žádný záznam uživatele z databáze sem
 * nevstupuje – co se dostane do RSC payloadu, to je v prohlížeči čitelné,
 * i kdyby se to nikde nevykreslilo.
 */

const ROLE_VOLBY = [
  { value: 'DOCTOR', label: 'Lékař', popis: 'Balíčky, knihovna šablon, audit' },
  { value: 'NURSE', label: 'Sestra', popis: 'Balíčky a jejich předání' },
  { value: 'PRACTICE_ADMIN', label: 'Admin ordinace', popis: 'Uživatelé a nastavení ordinace' },
] as const

export function UzivatelForm() {
  const [state, action, isPending] = useActionState<CreateUserState, FormData>(createUser, {})

  // Heslo se ukáže jen do chvíle, než ho admin odklikne. Stav akce si Next
  // drží i po opětovném vykreslení stránky, takže se schovaný panel pozná
  // podle id účtu, ke kterému patřil – po založení dalšího se objeví znovu.
  const [odklikleId, setOdklikleId] = useState<string | null>(null)
  const zalozeny = state.created && state.created.id !== odklikleId ? state.created : null

  if (zalozeny) {
    return (
      <div className="space-y-4">
        <Alert tone="uspech">
          Účet pro uživatele {zalozeny.name} ({zalozeny.email}) je založený.
        </Alert>

        <div className="rounded-xl border-2 border-varovani/40 bg-varovani/5 p-5">
          <p className="mb-2 font-medium">Jednorázové heslo</p>
          <p className="font-mono text-3xl leading-tight font-bold tracking-widest break-all select-all">
            {zalozeny.password}
          </p>
          <p className="mt-3 text-sm text-text-tlumeny">
            Heslo se zobrazí jen jednou a nikam se neodesílá. Předejte ho osobně a vyzvěte
            uživatele, ať si ho po prvním přihlášení změní. Když ho ztratíte, založte heslo nové.
          </p>
        </div>

        <Button variant="vedlejsi" onClick={() => setOdklikleId(zalozeny.id)}>
          Mám heslo opsané, skrýt
        </Button>
      </div>
    )
  }

  return (
    <form action={action} className="space-y-5">
      {state.error ? <Alert>{state.error}</Alert> : null}

      <Field label="Jméno a příjmení" errors={state.fieldErrors?.name}>
        <Input name="name" autoComplete="off" required maxLength={200} />
      </Field>

      <Field
        label="E-mail"
        hint="Slouží jako přihlašovací jméno. Musí být jedinečný."
        errors={state.fieldErrors?.email}
      >
        <Input name="email" type="email" autoComplete="off" required maxLength={320} />
      </Field>

      <fieldset>
        <legend className="mb-1.5 font-medium">Role</legend>
        <p className="mb-2 text-sm text-text-tlumeny">
          Role se dají kombinovat. Lékař, který spravuje ordinaci, má obojí.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {ROLE_VOLBY.map((role) => (
            <label
              key={role.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-obrys p-4 hover:border-hlavni"
            >
              <input type="checkbox" name="roles" value={role.value} className="mt-1 size-5" />
              <span>
                <span className="block font-medium">{role.label}</span>
                <span className="block text-sm text-text-tlumeny">{role.popis}</span>
              </span>
            </label>
          ))}
        </div>
        {state.fieldErrors?.roles?.length ? (
          <span className="mt-1.5 block text-sm text-chyba" role="alert">
            {state.fieldErrors.roles.join(' ')}
          </span>
        ) : null}
      </fieldset>

      <p className="text-sm text-text-tlumeny">
        Heslo nezadáváte. Aplikace ho vygeneruje a zobrazí po založení účtu, abyste ho mohli
        předat osobně.
      </p>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Zakládám účet…' : 'Založit uživatele'}
      </Button>
    </form>
  )
}

export type OrdinaceVychozi = {
  name: string
  addressLine: string | null
  linkTtlDays: number
  handoffTtlSeconds: number
  sessionIdleMinutes: number
}

export function OrdinaceForm({ vychozi }: { vychozi: OrdinaceVychozi }) {
  const [state, action, isPending] = useActionState<PracticeState, FormData>(updatePractice, {})

  return (
    <form action={action} className="space-y-5">
      {state.error ? <Alert>{state.error}</Alert> : null}
      {state.saved ? <Alert tone="uspech">Nastavení ordinace je uložené.</Alert> : null}

      <Field
        label="Název ordinace"
        hint="Vidí ho pacient na stránce s dokumenty i po přiložení telefonu."
        errors={state.fieldErrors?.name}
      >
        <Input name="name" defaultValue={vychozi.name} required maxLength={200} />
      </Field>

      <Field
        label="Adresní řádek"
        hint="Nepovinné. Pomůže pacientovi poznat, že je na stránce správné ordinace."
        errors={state.fieldErrors?.addressLine}
      >
        <Input
          name="addressLine"
          defaultValue={vychozi.addressLine ?? ''}
          maxLength={200}
          placeholder="Např. Dlouhá 12, Praha 1"
        />
      </Field>

      <Field
        label="Platnost odkazu ve dnech"
        hint="Jak dlouho si pacient může předané dokumenty otevřít. Po uplynutí se soubory smažou a odkaz přestane fungovat. Rozmezí 1 až 365 dní, obvykle 30."
        errors={state.fieldErrors?.linkTtlDays}
      >
        <Input
          name="linkTtlDays"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          step={1}
          defaultValue={vychozi.linkTtlDays}
          required
        />
      </Field>

      <Field
        label="Okno předání v sekundách"
        hint="Kolik času má pacient na přiložení telefonu a zadání kódu, než se předání samo zruší. Kratší okno je bezpečnější, delší se hodí u pacientů, kteří s telefonem zápolí. Rozmezí 30 až 900 sekund, obvykle 180."
        errors={state.fieldErrors?.handoffTtlSeconds}
      >
        <Input
          name="handoffTtlSeconds"
          type="number"
          inputMode="numeric"
          min={30}
          max={900}
          step={1}
          defaultValue={vychozi.handoffTtlSeconds}
          required
        />
      </Field>

      <Field
        label="Odhlášení při nečinnosti v minutách"
        hint="Po jak dlouhé nečinnosti se přihlášení samo ukončí. V ordinaci, kam pacienti vidí na obrazovku, volte kratší čas. Rozmezí 5 až 480 minut, obvykle 30."
        errors={state.fieldErrors?.sessionIdleMinutes}
      >
        <Input
          name="sessionIdleMinutes"
          type="number"
          inputMode="numeric"
          min={5}
          max={480}
          step={1}
          defaultValue={vychozi.sessionIdleMinutes}
          required
        />
      </Field>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Ukládám…' : 'Uložit nastavení'}
      </Button>
    </form>
  )
}

/**
 * Změna stavu uživatele.
 *
 * Zablokování je okamžité a odhlásí kolegu ze všech zařízení – klidně uprostřed
 * ordinační hodiny nad rozdělaným balíčkem. Na tabletu se přitom o tlačítko
 * v tabulce snadno zavadí palcem při rolování, proto se zablokování potvrzuje.
 * Odblokování zůstává na jedno klepnutí, protože nic nerozbije.
 */
export function StavUzivateleForm({
  userId,
  userName,
  zablokovany,
}: {
  userId: string
  userName: string
  zablokovany: boolean
}) {
  const [ptamSe, setPtamSe] = useState(false)

  if (!zablokovany && !ptamSe) {
    return (
      <Button
        type="button"
        variant="vedlejsi"
        className="whitespace-nowrap"
        onClick={() => setPtamSe(true)}
        aria-label={`Zablokovat uživatele ${userName}`}
      >
        Zablokovat
      </Button>
    )
  }

  return (
    <form action={setUserStatus} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="status" value={zablokovany ? 'ACTIVE' : 'DISABLED'} />

      {ptamSe ? (
        <span className="text-sm text-text-tlumeny">
          Zablokovat {userName}? Okamžitě se odhlásí ze všech zařízení.
        </span>
      ) : null}

      <StavTlacitko zablokovany={zablokovany} potvrzuji={ptamSe} />

      {ptamSe ? (
        <Button type="button" variant="nenapadny" onClick={() => setPtamSe(false)}>
          Zpět
        </Button>
      ) : null}
    </form>
  )
}

/**
 * Tlačítko musí být zvlášť: useFormStatus čte stav formuláře, ve kterém je
 * vnořené, takže ve stejné komponentě jako <form> by hlásilo pořád false
 * a šlo by odeslat dvakrát.
 */
function StavTlacitko({ zablokovany, potvrzuji }: { zablokovany: boolean; potvrzuji: boolean }) {
  const { pending } = useFormStatus()

  const popisek = zablokovany ? 'Odblokovat' : potvrzuji ? 'Ano, zablokovat' : 'Zablokovat'
  const probiha = zablokovany ? 'Odblokovávám…' : 'Blokuji…'

  return (
    <Button type="submit" variant="vedlejsi" className="whitespace-nowrap" disabled={pending}>
      {pending ? probiha : popisek}
    </Button>
  )
}

/**
 * Obnova přístupu k účtu.
 *
 * Existuje proto, že přihlašovací obrazovky obě tyhle cesty slibují:
 * „Zapomenuté heslo vám nastaví nové správce ordinace" a „Druhý faktor vám
 * zruší správce ordinace". Bez nich byl člověk, který přišel o telefon,
 * z aplikace zamčený nadobro – dvoufázové přihlášení je povinné.
 *
 * Obě akce ruší všechny relace dotčeného účtu, proto se potvrzují.
 */
export function ObnovaPristupu({
  userId,
  userName,
  jaSam,
  maDruhyFaktor,
}: {
  userId: string
  userName: string
  jaSam: boolean
  maDruhyFaktor: boolean
}) {
  const [heslo, hesloAkce] = useActionState(resetUserPassword, PRAZDNY_OBNOVA_STAV)
  const [faktor, faktorAkce] = useActionState(resetUserTotp, PRAZDNY_OBNOVA_STAV)
  const [ptamSe, setPtamSe] = useState<'heslo' | 'faktor' | null>(null)

  const noveHeslo = heslo.noveHeslo
  const zruseno = faktor.zruseno2fa

  // Heslo se zobrazí jednou. Dokud je na obrazovce, nic jiného se nenabízí –
  // kdyby si ho admin nepřepsal a klepl jinam, už ho nikde nezíská.
  if (noveHeslo) {
    return (
      <div className="space-y-2 text-left">
        <p className="text-sm font-medium">Nové heslo pro {noveHeslo.jmeno}</p>
        <p className="udaj rounded-lg border border-obrys-silny bg-podklad px-3 py-2 text-base font-semibold break-all select-all">
          {noveHeslo.heslo}
        </p>
        <p className="text-xs text-text-tlumeny">
          Zobrazí se jen jednou. Předejte ho osobně – aplikace hesla neposílá e-mailem.
          Uživatel byl odhlášen ze všech zařízení.
        </p>
      </div>
    )
  }

  if (zruseno) {
    return (
      <p className="text-left text-sm text-uspech">
        Druhý faktor pro {zruseno.jmeno} je zrušený.{' '}
        {zruseno.jaSam
          ? 'Jste odhlášeni – při dalším přihlášení si nastavíte nový.'
          : 'Uživatel si ho nastaví při nejbližším přihlášení.'}
      </p>
    )
  }

  if (ptamSe === null) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="nenapadny" onClick={() => setPtamSe('heslo')}>
          Nové heslo
        </Button>
        {maDruhyFaktor ? (
          <Button type="button" variant="nenapadny" onClick={() => setPtamSe('faktor')}>
            Zrušit ověření
          </Button>
        ) : null}
      </div>
    )
  }

  const jeHeslo = ptamSe === 'heslo'
  const chyba = jeHeslo ? heslo.error : faktor.error

  return (
    <form action={jeHeslo ? hesloAkce : faktorAkce} className="space-y-2 text-left">
      <input type="hidden" name="userId" value={userId} />

      <p className="text-sm text-text-tlumeny">
        {jeHeslo
          ? `Nastavit ${userName} nové jednorázové heslo? Bude odhlášen ze všech zařízení.`
          : jaSam
            ? 'Zrušit si druhý faktor? Budete odhlášeni a při dalším přihlášení si nastavíte nový.'
            : `Zrušit ${userName} druhý faktor? Bude odhlášen a nastaví si nový při přihlášení.`}
      </p>

      {chyba ? <Alert tone="chyba">{chyba}</Alert> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <ObnovaTlacitko jeHeslo={jeHeslo} />
        <Button type="button" variant="nenapadny" onClick={() => setPtamSe(null)}>
          Zpět
        </Button>
      </div>
    </form>
  )
}

/** Vlastní komponenta: useFormStatus čte stav formuláře, ve kterém je vnořený. */
function ObnovaTlacitko({ jeHeslo }: { jeHeslo: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="vedlejsi" disabled={pending}>
      {pending
        ? jeHeslo
          ? 'Nastavuji…'
          : 'Ruším…'
        : jeHeslo
          ? 'Ano, nové heslo'
          : 'Ano, zrušit'}
    </Button>
  )
}
