import type { ComponentProps, ReactNode } from 'react'

/**
 * Sdílené prvky rozhraní.
 *
 * Ordinace se ovládá ve spěchu, často na tabletu a někdy jen klávesnicí.
 * Prvky jsou proto větší, než je na webu zvykem, a mají zřetelné zaměření.
 */

function classes(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

export function Button({
  variant = 'hlavni',
  size = 'normalni',
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: 'hlavni' | 'vedlejsi' | 'nenapadny'
  size?: 'normalni' | 'velke'
}) {
  return (
    <button
      {...props}
      className={classes(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'velke' ? 'min-h-24 px-8 text-xl' : 'min-h-12 px-5 text-base',
        variant === 'hlavni' && 'bg-hlavni text-white hover:bg-hlavni-tmavy',
        variant === 'vedlejsi' && 'border-2 border-obrys bg-plocha text-text hover:border-hlavni',
        variant === 'nenapadny' && 'text-text-tlumeny hover:text-text underline underline-offset-4',
        className,
      )}
    />
  )
}

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
  return (
    <label className="block">
      <span className="mb-1.5 block font-medium">{label}</span>
      {hint ? <span className="mb-1.5 block text-sm text-text-tlumeny">{hint}</span> : null}
      {children}
      {errors?.length ? (
        <span className="mt-1.5 block text-sm text-chyba" role="alert">
          {errors.join(' ')}
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
        'block w-full rounded-xl border-2 border-obrys bg-plocha px-4 py-3',
        'text-base outline-none focus:border-hlavni',
        className,
      )}
    />
  )
}

export function Alert({
  tone = 'chyba',
  children,
}: {
  tone?: 'chyba' | 'uspech' | 'info'
  children: ReactNode
}) {
  return (
    <p
      role={tone === 'chyba' ? 'alert' : 'status'}
      className={classes(
        'rounded-xl border-2 px-4 py-3 text-sm',
        tone === 'chyba' && 'border-chyba/30 bg-chyba/5 text-chyba',
        tone === 'uspech' && 'border-uspech/30 bg-uspech/5 text-uspech',
        tone === 'info' && 'border-obrys bg-podklad text-text-tlumeny',
      )}
    >
      {children}
    </p>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={classes('rounded-2xl border border-obrys bg-plocha p-6 shadow-sm', className)}>
      {children}
    </div>
  )
}

/** Stránka bez navigace – přihlašování, ověření, nastavení 2FA. */
export function CenteredPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <h1 className="mb-6 text-center text-2xl font-semibold">{title}</h1>
      <Card>{children}</Card>
    </main>
  )
}
