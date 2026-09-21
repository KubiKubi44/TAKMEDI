'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { Prisma } from '@/generated/prisma/client'
import type { Role } from '@/generated/prisma/enums'
import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requireRole } from '@/lib/auth'
import { generateRecoveryCode } from '@/lib/crypto'
import { withPractice } from '@/lib/db'
import { hashPassword } from '@/lib/password'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'
import { revokeAllSessions } from '@/lib/session'

/**
 * Správa uživatelů a nastavení ordinace.
 *
 * Celý soubor je vyhrazený roli PRACTICE_ADMIN a každá akce si oprávnění ověří
 * sama. Kontrola na stránce je pohodlí pro uživatele, ne ochrana – Server
 * Action se dá zavolat i bez toho, aby si útočník stránku vůbec otevřel.
 *
 * Ordinace se bere výhradně ze session. Žádná zdejší akce nepřijímá practiceId
 * zvenčí, takže neexistuje způsob, jak si ji ve formuláři přepsat na cizí.
 */

const CHYBA_CIZI_PUVOD = 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.'

const ROLE_VALUES = ['DOCTOR', 'NURSE', 'PRACTICE_ADMIN'] as const satisfies readonly Role[]

// ---------------------------------------------------------------------------
// Nový uživatel
// ---------------------------------------------------------------------------

export type CreateUserState = {
  error?: string
  fieldErrors?: { name?: string[]; email?: string[]; roles?: string[] }
  /** Vyplněné jen po úspěchu. Heslo se odsud do prohlížeče posílá jedinkrát. */
  created?: { id: string; name: string; email: string; password: string }
}

const CreateUserSchema = z.object({
  name: z
    .string({ error: 'Zadejte jméno.' })
    .trim()
    .min(2, { error: 'Zadejte jméno, alespoň dva znaky.' })
    .max(200, { error: 'Jméno může mít nejvýše 200 znaků.' }),
  email: z
    .string({ error: 'Zadejte platný e-mail.' })
    .trim()
    .toLowerCase()
    // Ořez a převod na malá písmena musí proběhnout PŘED kontrolou tvaru,
    // jinak by mezera zkopírovaná spolu s adresou znamenala neplatný e-mail.
    .pipe(
      z
        .email({ error: 'Zadejte platný e-mail.' })
        .max(320, { error: 'E-mail může mít nejvýše 320 znaků.' }),
    ),
  roles: z
    .array(z.string())
    // Neznámé hodnoty se tiše zahodí – rolí není nic jiného než tyhle tři a
    // do formuláře se jiná dostat nemůže. Prázdný výsledek je chyba obsluhy.
    .transform((values) =>
      values.filter((value): value is Role => (ROLE_VALUES as readonly string[]).includes(value)),
    )
    .refine((values) => values.length > 0, { error: 'Vyberte alespoň jednu roli.' }),
})

export async function createUser(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const session = await requireRole('PRACTICE_ADMIN')

  const parsed = CreateUserSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    roles: formData.getAll('roles').map((value) => String(value)),
  })

  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return {
      fieldErrors: {
        name: tree.properties?.name?.errors,
        email: tree.properties?.email?.errors,
        roles: tree.properties?.roles?.errors,
      },
    }
  }

  const { name, email, roles } = parsed.data
  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  /*
   * Heslo nezadává admin a neposílá se e-mailem.
   *
   * Vymyšlené heslo bývá slabé a stejné pro celou ordinaci. E-mail by ho navíc
   * uložil do schránky, která je v ordinaci často sdílená a ze které se zprávy
   * nemažou – přihlašovací údaj by tam ležel dál i po jeho změně. Dvě spojená
   * náhodná tajemství dávají dvacet znaků z abecedy bez zaměnitelných písmen,
   * takže se dají bez chyby přečíst z papíru a předat z ruky do ruky.
   */
  const jednorazoveHeslo = `${generateRecoveryCode()}-${generateRecoveryCode()}`

  // Argon2id je záměrně pomalý, proto běží mimo transakci – ta má být krátká.
  const passwordHash = await hashPassword(jednorazoveHeslo)

  try {
    const created = await withPractice(practiceId, async (db) => {
      const user = await db.user.create({
        data: { practiceId, name, email, roles, passwordHash },
        select: { id: true, name: true, email: true },
      })

      await writeAudit(db, practiceId, {
        action: 'USER_CREATED',
        actorType: 'USER',
        actorUserId: session.userId,
        actorName: session.user.name,
        metadata: { novyUzivatelId: user.id, jmeno: user.name, role: roles },
        context,
      })

      return user
    })

    revalidatePath('/nastaveni')

    return { created: { ...created, password: jednorazoveHeslo } }
  } catch (error) {
    // E-mail je unikátní v rámci celé instalace, takže kolize může nastat i
    // s účtem v jiné ordinaci. Hláška proto o cizí ordinaci nic neprozrazuje.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { fieldErrors: { email: ['Uživatel s tímto e-mailem už existuje.'] } }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Zablokování a odblokování
// ---------------------------------------------------------------------------

const SetStatusSchema = z.object({
  userId: z.uuid({ error: 'Neplatný uživatel.' }),
  status: z.enum(['ACTIVE', 'DISABLED'], { error: 'Neplatný stav.' }),
})

export async function setUserStatus(formData: FormData): Promise<void> {
  await requireTrustedOrigin()
  const session = await requireRole('PRACTICE_ADMIN')

  const parsed = SetStatusSchema.safeParse({
    userId: formData.get('userId'),
    status: formData.get('status'),
  })
  if (!parsed.success) throw new ForbiddenError('Neplatný požadavek na změnu stavu účtu.')

  const { userId, status } = parsed.data

  // Skryté tlačítko u vlastního řádku je jen ohled na obsluhu. Kdyby ordinace
  // přišla o jediného správce, nezbyl by nikdo, kdo účty odblokuje.
  if (userId === session.userId) {
    throw new ForbiddenError('Vlastní účet zablokovat nelze.')
  }

  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const target = await withPractice(practiceId, async (db) => {
    // Řádek cizí ordinace politika RLS nevrátí, takže null tady znamená
    // „cizí nebo neexistující účet" a dál se s ním nepracuje.
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } })
    if (!user) return null

    await db.user.update({ where: { id: userId }, data: { status } })

    await writeAudit(db, practiceId, {
      action: status === 'DISABLED' ? 'USER_DISABLED' : 'USER_UPDATED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { cilovyUzivatelId: userId, jmeno: user.name, novyStav: status },
      context,
    })

    return user
  })

  if (!target) throw new ForbiddenError('Takový uživatel v této ordinaci není.')

  if (status === 'DISABLED') {
    // Zablokovat účet nestačí – uživatel má otevřenou relaci a ta by platila
    // dál. Relace se ruší až po potvrzení změny stavu, aby se mezitím nestihl
    // přihlásit znovu.
    await revokeAllSessions(userId)
  }

  revalidatePath('/nastaveni')
}

// ---------------------------------------------------------------------------
// Nastavení ordinace
// ---------------------------------------------------------------------------

export type PracticeState = {
  error?: string
  saved?: boolean
  fieldErrors?: {
    name?: string[]
    addressLine?: string[]
    linkTtlDays?: string[]
    handoffTtlSeconds?: string[]
    sessionIdleMinutes?: string[]
  }
}

/**
 * Celé číslo v mezích. Hláška je u všech kontrol stejná – uživateli stačí
 * vědět, co se do pole vejde, ne který z kroků ověření zakopl.
 */
function celeCislo(min: number, max: number, hlaska: string) {
  return z.coerce
    .number({ error: hlaska })
    .int({ error: hlaska })
    .min(min, { error: hlaska })
    .max(max, { error: hlaska })
}

const PracticeSchema = z.object({
  name: z
    .string({ error: 'Zadejte název ordinace.' })
    .trim()
    .min(2, { error: 'Zadejte název ordinace, alespoň dva znaky.' })
    .max(200, { error: 'Název může mít nejvýše 200 znaků.' }),
  addressLine: z
    .string({ error: 'Adresu zadejte jako text.' })
    .trim()
    .max(200, { error: 'Adresa může mít nejvýše 200 znaků.' }),
  linkTtlDays: celeCislo(1, 365, 'Zadejte počet dní od 1 do 365.'),
  handoffTtlSeconds: celeCislo(30, 900, 'Zadejte počet sekund od 30 do 900.'),
  sessionIdleMinutes: celeCislo(5, 480, 'Zadejte počet minut od 5 do 480.'),
})

export async function updatePractice(
  _prev: PracticeState,
  formData: FormData,
): Promise<PracticeState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const session = await requireRole('PRACTICE_ADMIN')

  const parsed = PracticeSchema.safeParse({
    name: formData.get('name'),
    addressLine: formData.get('addressLine') ?? '',
    linkTtlDays: formData.get('linkTtlDays'),
    handoffTtlSeconds: formData.get('handoffTtlSeconds'),
    sessionIdleMinutes: formData.get('sessionIdleMinutes'),
  })

  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return {
      fieldErrors: {
        name: tree.properties?.name?.errors,
        addressLine: tree.properties?.addressLine?.errors,
        linkTtlDays: tree.properties?.linkTtlDays?.errors,
        handoffTtlSeconds: tree.properties?.handoffTtlSeconds?.errors,
        sessionIdleMinutes: tree.properties?.sessionIdleMinutes?.errors,
      },
    }
  }

  const practiceId = session.user.practiceId
  const context = await getRequestContext()

  const nova = {
    name: parsed.data.name,
    // Prázdné pole znamená „adresa není", ne prázdný řetězec – pacientovi se
    // pak neukáže osiřelý řádek.
    addressLine: parsed.data.addressLine === '' ? null : parsed.data.addressLine,
    linkTtlDays: parsed.data.linkTtlDays,
    handoffTtlSeconds: parsed.data.handoffTtlSeconds,
    sessionIdleMinutes: parsed.data.sessionIdleMinutes,
  }

  await withPractice(practiceId, async (db) => {
    const puvodni = await db.practice.findUniqueOrThrow({
      where: { id: practiceId },
      select: {
        name: true,
        addressLine: true,
        linkTtlDays: true,
        handoffTtlSeconds: true,
        sessionIdleMinutes: true,
      },
    })

    await db.practice.update({ where: { id: practiceId }, data: nova })

    // Do auditu jde jen to, co se opravdu změnilo, a vždy s původní hodnotou.
    // Záznam „změnil nastavení" bez čísel by se při pozdějším dohledávání
    // nedal k ničemu použít.
    const zmeny = Object.fromEntries(
      Object.entries(nova)
        .filter(([klic, hodnota]) => hodnota !== puvodni[klic as keyof typeof puvodni])
        .map(([klic, hodnota]) => [klic, { z: puvodni[klic as keyof typeof puvodni], na: hodnota }]),
    )

    await writeAudit(db, practiceId, {
      action: 'SETTINGS_CHANGED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      metadata: { zmeny },
      context,
    })
  })

  revalidatePath('/nastaveni')

  return { saved: true }
}
