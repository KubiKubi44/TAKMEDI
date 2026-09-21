import type { ComponentProps, ReactNode } from 'react'

/**
 * Sdílené prvky rozhraní.
 *
 * Vizuální řeč je popsaná v src/app/globals.css: ordinační tiskopis, jedna
 * barva inkoustu, zřetelné linky, údaje vysázené neproporcionálním písmem.
 * Prvky jsou větší, než je na webu zvykem – ordinace se ovládá ve spěchu,
 * na tabletu a často přes půl stolu.
 */

function classes(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Tlačítko
// ---------------------------------------------------------------------------

const VARIANTY = {
  hlavni:
    'bg-hlavni text-white shadow-[0_1px_2px_rgb(0_0_0/0.08)] hover:bg-hlavni-tmavy active:translate-y-px',
  vedlejsi:
    'border border-obrys-silny bg-plocha text-text hover:border-hlavni hover:text-hlavni-tmavy active:translate-y-px',
  nenapadny: 'text-text-tlumeny underline decoration-obrys-silny underline-offset-4 hover:text-hlavni',
} as const

export function Button({
  variant = 'hlavni',
  size = 'normalni',
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: keyof typeof VARIANTY
  size?: 'normalni' | 'velke'
}) {
  return (
    <button
      {...props}
      className={classes(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium',
        'transition-[background-color,border-color,color,transform] duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        size === 'velke'
          ? 'min-h-[5.25rem] px-7 text-lg font-semibold tracking-tight'
          : 'min-h-12 px-5 text-base',
        VARIANTY[variant],
        className,
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Formulářové pole
// ---------------------------------------------------------------------------

/**
 * Popisek pole je věta, ne verzálky.
 *
 * Verzálky s prostrkáním (.popisek-udaje) patří nad ÚDAJ v tabulce, kde se
 * jen hledá očima. Otázku na uživatele, který spěchá, je potřeba přečíst.
 */
export function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string
  hint?: string
  errors?: string[]
  children: ReactNode
}) {
  const chybne = Boolean(errors?.length)

  return (
    <label className="block">
      <span className="mb-1.5 block font-medium">{label}</span>
      {hint ? <span className="mb-2 block text-sm text-text-tlumeny">{hint}</span> : null}
      {children}
      {chybne ? (
        <span className="mt-2 flex items-start gap-2 text-sm text-chyba" role="alert">
          {/* Svislá linka místo ikony: nese stejnou informaci a nevyžaduje obrázek. */}
          <span aria-hidden="true" className="mt-[0.35rem] h-3 w-0.5 shrink-0 bg-chyba" />
          {errors!.join(' ')}
        </span>
      ) : null}
    </label>
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={classes(
        'block w-full rounded-xl border border-obrys-silny bg-plocha px-4 py-3',
        'text-base text-text placeholder:text-text-tlumeny/70',
        'transition-[border-color,box-shadow] duration-100',
        'outline-none focus:border-hlavni focus:ring-4 focus:ring-hlavni/12',
        'disabled:bg-podklad disabled:text-text-tlumeny',
        className,
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Sdělení
// ---------------------------------------------------------------------------

const TONY = {
  chyba: 'border-chyba/35 bg-chyba-svetly text-chyba',
  uspech: 'border-uspech/35 bg-uspech-svetly text-uspech',
  info: 'border-obrys bg-podklad text-text-tlumeny',
} as const

/**
 * Svislý pruh vlevo místo plného barevného rámečku.
 *
 * Plocha tónovaná celá přitahuje pozornost i tehdy, když jen něco vysvětluje.
 * Pruh drží sdělení v klidu a zároveň je nepřehlédnutelné.
 */
export function Alert({
  tone = 'chyba',
  children,
}: {
  tone?: keyof typeof TONY
  children: ReactNode
}) {
  return (
    <p
      role={tone === 'chyba' ? 'alert' : 'status'}
      className={classes(
        'rounded-r-xl border border-l-[3px] py-3 pr-4 pl-4 text-sm leading-relaxed',
        TONY[tone],
      )}
    >
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Plochy
// ---------------------------------------------------------------------------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={classes(
        'rounded-2xl border border-obrys bg-plocha p-6',
        'shadow-[0_1px_2px_rgb(16_24_40/0.04),0_1px_3px_rgb(16_24_40/0.03)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Stránka bez navigace – přihlášení, ověření, nastavení druhého faktoru. */
export function CenteredPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <div className="mb-7 text-center">
        <p className="popisek-udaje">MedPředání</p>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
      </div>
      <Card className="sm:p-7">{children}</Card>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Štítek
// ---------------------------------------------------------------------------

const ZNACKY = {
  neutralni: 'border-obrys bg-podklad text-text-tlumeny',
  hlavni: 'border-hlavni/25 bg-hlavni-svetly text-hlavni-tmavy',
  uspech: 'border-uspech/25 bg-uspech-svetly text-uspech',
  chyba: 'border-chyba/25 bg-chyba-svetly text-chyba',
} as const

/**
 * Krátký štítek u údaje: kód MKN-10, kanál předání, stav účtu.
 *
 * Kódy se sázejí neproporcionálním písmem, protože jsou to ÚDAJE k porovnání
 * a k opsání, ne text ke čtení.
 */
export function Znacka({
  tone = 'neutralni',
  mono = false,
  children,
}: {
  tone?: keyof typeof ZNACKY
  mono?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={classes(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        mono && 'udaj tracking-wide uppercase',
        ZNACKY[tone],
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Prázdný stav
// ---------------------------------------------------------------------------

/**
 * Prázdná obrazovka je výzva k akci, ne oznámení o prázdnu.
 *
 * Proto se vždycky říká, co sem patří a co má uživatel udělat dál – nikdy
 * jen „nic tu není".
 */
export function PrazdnyStav({
  nadpis,
  popis,
  children,
}: {
  nadpis: string
  popis: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-dashed border-obrys-silny bg-plocha px-6 py-10 text-center">
      <p className="text-lg font-semibold">{nadpis}</p>
      <p className="mx-auto mt-2 max-w-md text-text-tlumeny">{popis}</p>
      {children ? <div className="mt-6 flex flex-wrap justify-center gap-3">{children}</div> : null}
    </div>
  )
}
