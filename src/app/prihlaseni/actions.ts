'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'

import { writeAnonymousAudit, writeAudit } from '@/lib/audit'
import { encryptField, decryptField } from '@/lib/crypto'
import { resolverClient, withPractice } from '@/lib/db'
import { hashPassword, needsRehash, verifyPassword } from '@/lib/password'
import { hitRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'
import {
  clearSessionCookie,
  confirmTotpAndRotate,
  createSession,
  revokeSession,
  setSessionCookie,
} from '@/lib/session'
import { getSession, requireHalfSession, TotpAlreadySetError } from '@/lib/auth'
import { createTotpEnrollment, renderTotpEnrollment, verifyTotp } from '@/lib/totp'

/**
 * Přihlašování.
 *
 * Základní pravidlo celého souboru: ven se nikdy nedostane informace o tom,
 * který krok selhal. Uživatel se nesmí dozvědět, jestli daný e-mail v aplikaci
 * existuje, jestli je účet zablokovaný nebo jestli bylo špatně jen heslo.
 * Pro poctivce je to bez rozdílu, pro útočníka je to rozdíl zásadní.
 */

const CHYBA_PRIHLASENI = 'Nesprávný e-mail nebo heslo.'
const CHYBA_ZAMCENO =
  'Účet je po několika nesprávných pokusech dočasně zamčený. Zkuste to prosím za 15 minut.'
const CHYBA_ZABLOKOVANO =
  'Účet je zablokovaný. Obraťte se na správce ordinace.'
const CHYBA_PRILIS_POKUSU = 'Příliš mnoho pokusů. Zkuste to prosím za chvíli.'
const CHYBA_CIZI_PUVOD = 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.'

/** Po kolika nezdarech se účet zamkne a na jak dlouho. */
const MAX_NEUSPESNYCH = 5
const ZAMEK_MINUT = 15

export type LoginState = {
  error?: string
  fieldErrors?: { email?: string[]; password?: string[] }
}

const LoginSchema = z.object({
  email: z.email({ error: 'Zadejte platný e-mail.' }).trim().toLowerCase(),
  password: z.string().min(1, { error: 'Zadejte heslo.' }),
})

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return {
      fieldErrors: {
        email: tree.properties?.email?.errors,
        password: tree.properties?.password?.errors,
      },
    }
  }

  const { email, password } = parsed.data
  const context = await getRequestContext()

  // Dvě nezávislá omezení: podle adresy proti plošnému zkoušení hesel a podle
  // e-mailu proti cílenému útoku na jeden účet z mnoha adres.
  const podleIp = await hitRateLimit({
    action: 'login:ip',
    identifier: context.ip ?? 'neznama',
    limit: 20,
    windowSeconds: 300,
  })
  const podleEmailu = await hitRateLimit({
    action: 'login:email',
    identifier: email,
    limit: 10,
    windowSeconds: 900,
  })

  if (!podleIp.allowed || !podleEmailu.allowed) {
    await writeAnonymousAudit({
      action: 'LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorName: email,
      metadata: { duvod: 'prekrocena_cetnost' },
      context,
    })
    return { error: CHYBA_PRILIS_POKUSU }
  }

  const user = await resolverClient.user.findUnique({
    where: { email },
    select: {
      id: true,
      practiceId: true,
      name: true,
      passwordHash: true,
      status: true,
      lockedUntil: true,
      totpConfirmedAt: true,
      practice: { select: { sessionIdleMinutes: true } },
    },
  })

  // Heslo se ověřuje VŽDY, i když uživatel neexistuje – proti návnadě. Bez toho
  // by se dalo podle doby odpovědi zjistit, kdo v aplikaci účet má.
  const hesloSedi = await verifyPassword(user?.passwordHash ?? null, password)

  const zamceny = user?.lockedUntil ? user.lockedUntil > new Date() : false
  const uspech = Boolean(user) && hesloSedi && user!.status === 'ACTIVE' && !zamceny

  if (!uspech) {
    if (!user) {
      await writeAnonymousAudit({
        action: 'LOGIN_FAILED',
        actorType: 'SYSTEM',
        actorName: email,
        metadata: { duvod: 'neznamy_email' },
        context,
      })
      return { error: CHYBA_PRIHLASENI }
    }

    // Když heslo SEDÍ a vázne jen stav účtu, řekneme to na rovinu. Kdo zná
    // správné heslo, o existenci účtu už stejně ví, takže mlžení nic nechrání –
    // jen by uživatele nutilo dokola zkoušet heslo, které je správné.
    // Počítadlo nezdarů se v takovém případě NEZVYŠUJE: jinak by se dal zámek
    // donekonečna prodlužovat.
    if (hesloSedi && user.status !== 'ACTIVE') {
      await zapisNeuspechBezPocitadla(user, context, 'ucet_zablokovany')
      return { error: CHYBA_ZABLOKOVANO }
    }
    if (hesloSedi && zamceny) {
      await zapisNeuspechBezPocitadla(user, context, 'ucet_zamceny')
      return { error: CHYBA_ZAMCENO }
    }

    await zaznamenejNeuspech(user.id, user.practiceId, user.name, email, context, zamceny)
    return { error: CHYBA_PRIHLASENI }
  }

  // Heslo prošlo. Relace vzniká hned, ale druhý faktor v ní zatím není
  // potvrzený, takže neotevírá nic než obrazovku pro jeho zadání.
  const idleMinutes = user!.practice.sessionIdleMinutes
  const { token, absoluteExpiresAt } = await createSession({
    userId: user!.id,
    idleMinutes,
    context,
  })

  await withPractice(user!.practiceId, async (db) => {
    await db.user.update({
      where: { id: user!.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        // Parametry hashování se časem zpřísňují; tady je heslo v ruce naposledy.
        ...(needsRehash(user!.passwordHash)
          ? { passwordHash: await hashPassword(password) }
          : {}),
      },
    })
  })

  await clearRateLimit('login:email', email)
  await setSessionCookie(token, absoluteExpiresAt)

  // redirect() vyhazuje zvláštní výjimku, kterou zpracovává Next – proto stojí
  // až tady, mimo jakýkoli try/catch.
  redirect(user!.totpConfirmedAt ? '/prihlaseni/overeni' : '/prihlaseni/nastaveni-2fa')
}

/** Zapíše nezdar, u kterého nemá smysl zvyšovat počítadlo. */
async function zapisNeuspechBezPocitadla(
  user: { id: string; practiceId: string; name: string },
  context: { ip: string | null; userAgent: string | null },
  duvod: string,
): Promise<void> {
  await withPractice(user.practiceId, (db) =>
    writeAudit(db, user.practiceId, {
      action: 'LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorUserId: user.id,
      actorName: user.name,
      metadata: { duvod },
      context,
    }),
  )
}

/**
 * Zvýší počítadlo nezdarů a případně účet zamkne.
 *
 * Je to jediný příkaz, takže souběžné pokusy počítadlo neobejdou. Rozlišovací
 * role má na tyhle tři sloupce sloupcový GRANT UPDATE – na nic jiného v tabulce
 * uživatelů nedosáhne.
 */
async function zaznamenejNeuspech(
  userId: string,
  practiceId: string,
  userName: string,
  email: string,
  context: { ip: string | null; userAgent: string | null },
  jizZamceny: boolean,
): Promise<void> {
  const rows = await resolverClient.$queryRaw<{ failed_login_count: number }[]>`
    UPDATE "user"
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= ${MAX_NEUSPESNYCH}
             THEN now() + (${ZAMEK_MINUT} * interval '1 minute')
             ELSE locked_until
           END,
           updated_at = now()
     WHERE id = ${userId}::uuid
    RETURNING failed_login_count
  `

  const pocet = rows[0]?.failed_login_count ?? 0

  await withPractice(practiceId, (db) =>
    writeAudit(db, practiceId, {
      action: 'LOGIN_FAILED',
      actorType: 'SYSTEM',
      actorUserId: userId,
      actorName: userName,
      metadata: {
        duvod: jizZamceny ? 'ucet_zamceny' : 'spatne_heslo',
        pocetNeuspechu: pocet,
        zamceno: pocet >= MAX_NEUSPESNYCH,
      },
      context,
    }),
  )
}

// ---------------------------------------------------------------------------
// Druhý faktor
// ---------------------------------------------------------------------------

export type TotpState = { error?: string }

const TotpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: 'Kód má šest číslic.' }),
})

export async function verifyTotpCode(_prev: TotpState, formData: FormData): Promise<TotpState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const session = await requireHalfSession()
  const context = await getRequestContext()

  const parsed = TotpSchema.safeParse({ code: formData.get('code') })
  if (!parsed.success) return { error: 'Kód má šest číslic.' }

  const omezeni = await hitRateLimit({
    action: 'totp',
    identifier: session.userId,
    limit: 10,
    windowSeconds: 300,
  })
  if (!omezeni.allowed) return { error: CHYBA_PRILIS_POKUSU }

  const user = await withPractice(session.user.practiceId, (db) =>
    db.user.findUnique({
      where: { id: session.userId },
      select: { totpSecretEnc: true, totpLastCounter: true, email: true, name: true },
    }),
  )

  if (!user?.totpSecretEnc) redirect('/prihlaseni/nastaveni-2fa')

  const result = verifyTotp({
    secretBase32: decryptField(user.totpSecretEnc),
    accountLabel: user.email,
    token: parsed.data.code,
    lastCounter: user.totpLastCounter,
  })

  if (!result.ok) {
    await withPractice(session.user.practiceId, (db) =>
      writeAudit(db, session.user.practiceId, {
        action: 'TOTP_FAILED',
        actorType: 'USER',
        actorUserId: session.userId,
        actorName: user.name,
        metadata: { duvod: result.reason },
        context,
      }),
    )
    return { error: 'Kód nesouhlasí. Zkuste aktuální kód z aplikace.' }
  }

  await withPractice(session.user.practiceId, async (db) => {
    await db.user.update({
      where: { id: session.userId },
      data: { totpLastCounter: result.counter },
    })
    await writeAudit(db, session.user.practiceId, {
      action: 'LOGIN_SUCCESS',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: user.name,
      context,
    })
  })

  // Token relace se vyměňuje, aby hodnota získaná před druhým faktorem po něm
  // nezačala platit naplno.
  const novyToken = await confirmTotpAndRotate(session.id)
  await setSessionCookie(novyToken, new Date(Date.now() + 12 * 60 * 60 * 1000))

  await clearRateLimit('totp', session.userId)

  redirect('/')
}

// ---------------------------------------------------------------------------
// Nastavení druhého faktoru
// ---------------------------------------------------------------------------

export type EnrollState = { error?: string }

/**
 * Připraví tajemství a QR kód.
 *
 * Tajemství se rovnou ukládá do databáze jako NEPOTVRZENÉ (totpSecretEnc
 * vyplněné, totpConfirmedAt prázdné) a při dalším zobrazení stránky se znovu
 * použije. Má to dva důvody:
 *
 *  1. Kdyby vzniklo nové tajemství při každém načtení stránky, uživatel, který
 *     stránku obnoví po neúspěšném opsání kódu, by měl v telefonu uloženou
 *     starou položku, se kterou se už nikdy nepřihlásí.
 *  2. Potvrzovací akce tak tajemství NEPŘEBÍRÁ od klienta. Dřív putovalo přes
 *     skryté pole formuláře, takže si útočník mohl podstrčit vlastní.
 */
export async function prepareTotpEnrollment(): Promise<{
  uri: string
  qrDataUrl: string
  /**
   * Jen k ZOBRAZENÍ, pro případ, že telefon QR kód nenačte. Potvrzovací akce
   * ho zpátky nepřijímá – čte si ho z databáze.
   */
  secret: string
}> {
  const session = await requireHalfSession()
  if (session.user.totpConfirmed) throw new TotpAlreadySetError()

  const existing = await withPractice(session.user.practiceId, (db) =>
    db.user.findUnique({
      where: { id: session.userId },
      select: { totpSecretEnc: true, totpConfirmedAt: true },
    }),
  )

  if (existing?.totpConfirmedAt) throw new TotpAlreadySetError()

  if (existing?.totpSecretEnc) {
    const secret = decryptField(existing.totpSecretEnc)
    const view = await renderTotpEnrollment(secret, session.user.email)
    return { ...view, secret }
  }

  const enrollment = await createTotpEnrollment(session.user.email)

  await withPractice(session.user.practiceId, (db) =>
    db.user.updateMany({
      // Podmínka na prázdné totpConfirmedAt je tu i proti souběhu: dvě
      // souběžná načtení stránky nesmí přepsat už potvrzené tajemství.
      where: { id: session.userId, totpConfirmedAt: null },
      data: { totpSecretEnc: encryptField(enrollment.secretBase32) },
    }),
  )

  return {
    uri: enrollment.uri,
    qrDataUrl: enrollment.qrDataUrl,
    secret: enrollment.secretBase32,
  }
}

const EnrollSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: 'Kód má šest číslic.' }),
})

export async function confirmTotpEnrollment(
  _prev: EnrollState,
  formData: FormData,
): Promise<EnrollState> {
  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw error
  }

  const session = await requireHalfSession()
  const context = await getRequestContext()

  // Kdo druhý faktor už má, ten si ho tudy znovu nenastaví. Jinak by stačilo
  // znát heslo: útočník by si zaregistroval vlastní tajemství a druhý faktor
  // oběti by tím obešel.
  if (session.user.totpConfirmed) return { error: 'Druhý faktor je už nastavený.' }

  const parsed = EnrollSchema.safeParse({ code: formData.get('code') })
  if (!parsed.success) return { error: 'Kód má šest číslic.' }

  // Tajemství se čte z databáze, NIKDY z formuláře – jinak by si útočník mohl
  // podstrčit vlastní.
  const stored = await withPractice(session.user.practiceId, (db) =>
    db.user.findUnique({
      where: { id: session.userId },
      select: { totpSecretEnc: true, totpConfirmedAt: true },
    }),
  )

  if (stored?.totpConfirmedAt) return { error: 'Druhý faktor je už nastavený.' }
  if (!stored?.totpSecretEnc) {
    return { error: 'Nastavení vypršelo. Načtěte stránku znovu a QR kód načtěte do aplikace ještě jednou.' }
  }

  // Ověření prvním kódem je tu proto, aby si uživatel nezamkl účet špatně
  // načteným QR kódem. Potvrdí se až to, co prokazatelně funguje.
  const result = verifyTotp({
    secretBase32: decryptField(stored.totpSecretEnc),
    accountLabel: session.user.email,
    token: parsed.data.code,
    lastCounter: null,
  })

  if (!result.ok) {
    return { error: 'Kód nesouhlasí. Zkontrolujte, že jste QR kód načetli celý.' }
  }

  const potvrzeno = await withPractice(session.user.practiceId, async (db) => {
    // Podmínka na prázdné totpConfirmedAt je zámek proti souběhu dvou potvrzení.
    const { count } = await db.user.updateMany({
      where: { id: session.userId, totpConfirmedAt: null },
      data: {
        totpConfirmedAt: new Date(),
        totpLastCounter: result.counter,
      },
    })
    if (count === 0) return false

    await writeAudit(db, session.user.practiceId, {
      action: 'TOTP_ENROLLED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      context,
    })
    await writeAudit(db, session.user.practiceId, {
      action: 'LOGIN_SUCCESS',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      context,
    })
    return true
  })

  if (!potvrzeno) return { error: 'Druhý faktor je už nastavený.' }

  const novyToken = await confirmTotpAndRotate(session.id)
  await setSessionCookie(novyToken, new Date(Date.now() + 12 * 60 * 60 * 1000))

  redirect('/')
}

// ---------------------------------------------------------------------------
// Odhlášení
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  await requireTrustedOrigin()

  const session = await getSession()
  if (session) {
    const context = await getRequestContext()
    await revokeSession(session.id)
    await withPractice(session.user.practiceId, (db) =>
      writeAudit(db, session.user.practiceId, {
        action: 'LOGOUT',
        actorType: 'USER',
        actorUserId: session.userId,
        actorName: session.user.name,
        context,
      }),
    )
  }

  await clearSessionCookie()
  redirect('/prihlaseni')
}
