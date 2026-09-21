import 'server-only'

import { writeAudit } from './audit'
import {
  generateAccessToken,
  generateHandoffCode,
  generateTagSecret,
  hashToken,
  hmacSecret,
  secretMatches,
} from './crypto'
import { resolverClient, withPractice, type TenantClient } from './db'
import type { RequestInfo } from './request-context'

/**
 * Předání balíčku přes NFC čip.
 *
 * Tohle je bezpečnostně nejcitlivější část aplikace: čtyřmístný kód má jen
 * deset tisíc možností. Že to stačí, stojí na čtyřech věcech, a každá z nich
 * je vynucená jinde než v tomhle souboru:
 *
 * 1. V ordinaci může být v jednu chvíli JEDINÁ aktivace. Vynucuje to částečný
 *    unikátní index v databázi, ne kontrola v kódu. Uhodnutý kód tedy nikdy
 *    nemůže trefit „nějaký jiný" balíček.
 * 2. Počítadlo pokusů je GLOBÁLNÍ na aktivaci, ne na IP adresu. Šance na
 *    uhodnutí je proto nejvýš maxAttempts/10000 bez ohledu na to, kolik
 *    útočníků a z kolika adres se zapojí.
 * 3. Nárokování běží v transakci se SELECT ... FOR UPDATE, takže souběžné
 *    pokusy počítadlo neobejdou a token se nevydá dvakrát.
 * 4. Adresa na čipu obsahuje tajemství. Kdo telefon fyzicky nepřiložil,
 *    se k zadání kódu vůbec nedostane.
 */

export class HandoffError extends Error {
  constructor(
    readonly reason:
      | 'neznama-ordinace'
      | 'neplatny-cip'
      | 'nic-neceka'
      | 'vyprselo'
      | 'zamceno'
      | 'spatny-kod'
      | 'balicek-prazdny',
    message: string,
  ) {
    super(message)
    this.name = 'HandoffError'
  }
}

// ---------------------------------------------------------------------------
// NFC čip
// ---------------------------------------------------------------------------

/**
 * Vygeneruje čip a adresu k zápisu.
 *
 * Tajemství se vrátí JEDNOU a dál nikde neexistuje – v databázi je jen jeho
 * HMAC. Kdo adresu ztratí, vygeneruje čip znovu.
 */
export async function createNfcTag(params: {
  practiceId: string
  practiceSlug: string
  userId: string
  userName: string
  label: string
  appUrl: string
  context: RequestInfo
}): Promise<{ tagId: string; url: string }> {
  const secret = generateTagSecret()

  return withPractice(params.practiceId, async (db) => {
    const tag = await db.nfcTag.create({
      data: {
        practiceId: params.practiceId,
        label: params.label,
        secretHmac: hmacSecret(secret),
        createdById: params.userId,
      },
      select: { id: true },
    })

    await writeAudit(db, params.practiceId, {
      action: 'NFC_TAG_CREATED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      metadata: { tagId: tag.id, label: params.label },
      context: params.context,
    })

    return {
      tagId: tag.id,
      url: `${params.appUrl.replace(/\/$/, '')}/o/${params.practiceSlug}/${secret}`,
    }
  })
}

export type ResolvedPractice = {
  id: string
  name: string
  addressLine: string | null
  handoffTtlSeconds: number
  maxCodeAttempts: number
  linkTtlDays: number
}

/**
 * Přeloží slug a tajemství z čipu na ordinaci.
 *
 * Běží pod rozlišovací rolí, protože v tuhle chvíli ordinaci ještě neznáme –
 * teprve ji zjišťujeme. Ta role smí jen číst, co je potřeba k překladu.
 */
export async function resolvePracticeFromTag(
  slug: string,
  tagSecret: string | null,
): Promise<{ practice: ResolvedPractice; tagId: string | null }> {
  const practice = await resolverClient.practice.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      addressLine: true,
      handoffTtlSeconds: true,
      maxCodeAttempts: true,
      linkTtlDays: true,
    },
  })

  if (!practice) {
    throw new HandoffError('neznama-ordinace', 'Tahle stránka neexistuje.')
  }

  if (!tagSecret) return { practice, tagId: null }

  // Porovnává se HMAC, ne tajemství samo – únik databáze adresu čipu neprozradí.
  const tags = await resolverClient.nfcTag.findMany({
    where: { practiceId: practice.id, revokedAt: null },
    select: { id: true, secretHmac: true },
  })

  const tag = tags.find((candidate) => secretMatches(tagSecret, candidate.secretHmac))
  if (!tag) {
    throw new HandoffError('neplatny-cip', 'Tahle stránka neexistuje.')
  }

  return { practice, tagId: tag.id }
}

// ---------------------------------------------------------------------------
// Aktivace předání
// ---------------------------------------------------------------------------

export type Activation = {
  id: string
  code: string
  expiresAt: Date
}

/**
 * Otevře okno pro přiložení telefonu.
 *
 * Předchozí aktivace ordinace se ruší ve stejné transakci, ve které vzniká
 * nová – jinak by částečný unikátní index zápis odmítl a lékař by nepochopil proč.
 */
export async function activateHandoff(params: {
  practiceId: string
  packageId: string
  userId: string
  userName: string
  context: RequestInfo
}): Promise<Activation> {
  const code = generateHandoffCode()

  return withPractice(params.practiceId, async (db) => {
    const balicek = await db.package.findUnique({
      where: { id: params.packageId },
      select: { status: true, _count: { select: { documents: true } } },
    })
    if (!balicek) throw new HandoffError('nic-neceka', 'Balíček se nepodařilo najít.')
    if (balicek._count.documents === 0) {
      throw new HandoffError('balicek-prazdny', 'Balíček neobsahuje žádný dokument.')
    }

    const practice = await db.practice.findUniqueOrThrow({
      where: { id: params.practiceId },
      select: { handoffTtlSeconds: true, maxCodeAttempts: true },
    })

    await db.handoffActivation.updateMany({
      where: { practiceId: params.practiceId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    })

    const expiresAt = new Date(Date.now() + practice.handoffTtlSeconds * 1000)

    const activation = await db.handoffActivation.create({
      data: {
        practiceId: params.practiceId,
        packageId: params.packageId,
        codeHmac: hmacSecret(code),
        expiresAt,
        maxAttempts: practice.maxCodeAttempts,
        createdById: params.userId,
      },
      select: { id: true },
    })

    await writeAudit(db, params.practiceId, {
      action: 'HANDOFF_ACTIVATED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      packageId: params.packageId,
      metadata: { activationId: activation.id, platnostSekund: practice.handoffTtlSeconds },
      context: params.context,
    })

    // Kód se vrací JEDINÝM způsobem: sem, do odpovědi pro lékaře.
    // V databázi je jen jeho HMAC s pepperem uloženým mimo ni.
    return { id: activation.id, code, expiresAt }
  })
}

export type ActivationStatus = {
  status: 'ACTIVE' | 'CLAIMED' | 'EXPIRED' | 'CANCELLED' | 'LOCKED'
  expiresAt: Date
  attemptsLeft: number
}

/** Stav aktivace pro obrazovku lékaře, která se na něj ptá každé dvě sekundy. */
export async function getActivationStatus(
  db: TenantClient,
  activationId: string,
): Promise<ActivationStatus | null> {
  const activation = await db.handoffActivation.findUnique({
    where: { id: activationId },
    select: {
      status: true,
      expiresAt: true,
      attemptCount: true,
      maxAttempts: true,
    },
  })

  if (!activation) return null

  // Vypršení se nepozná zápisem, ale porovnáním času: kdyby se spoléhalo na
  // úklidovou úlohu, tvářila by se prošlá aktivace pořád jako otevřená.
  const status =
    activation.status === 'ACTIVE' && activation.expiresAt <= new Date()
      ? 'EXPIRED'
      : activation.status

  return {
    status,
    expiresAt: activation.expiresAt,
    attemptsLeft: Math.max(0, activation.maxAttempts - activation.attemptCount),
  }
}

/**
 * Zruší běžící předání.
 *
 * Vrací, jestli se opravdu něco zrušilo. Nezrušilo se, když pacient stihl kód
 * zadat o vteřinu dřív – a v takovém případě se obrazovka NESMÍ tvářit, že
 * předání neproběhlo. Balíček už je předaný a lékař to musí vidět.
 */
export async function cancelActivation(params: {
  practiceId: string
  activationId: string
  userId: string
  userName: string
  context: RequestInfo
}): Promise<boolean> {
  return withPractice(params.practiceId, async (db) => {
    const { count } = await db.handoffActivation.updateMany({
      where: { id: params.activationId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    })
    if (count === 0) return false

    await writeAudit(db, params.practiceId, {
      action: 'HANDOFF_CANCELLED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      metadata: { activationId: params.activationId },
      context: params.context,
    })

    return true
  })
}

// ---------------------------------------------------------------------------
// Nárokování pacientem
// ---------------------------------------------------------------------------

type ClaimResult =
  | { ok: true; token: string; packageId: string }
  | { ok: false; reason: HandoffError['reason']; message: string }

/**
 * Pacient zadal kód.
 *
 * Celé to běží v jedné transakci a začíná zamčením řádku aktivace
 * (SELECT ... FOR UPDATE). Bez toho by dva souběžné pokusy mohly obejít
 * počítadlo, nebo by se ze stejné aktivace vydaly dva tokeny.
 *
 * POZOR NA JEDNU VĚC: neúspěch se z transakce VRACÍ, nevyhazuje se z ní.
 * Kdyby se výjimka vyhodila uvnitř, transakce by se vrátila zpět i se
 * zvýšeným počítadlem pokusů – zámek po pěti pokusech by nikdy nenastal
 * a útočník by měl na čtyřmístný kód neomezeně pokusů. Výjimka se proto
 * skládá až po potvrzení transakce.
 *
 * Vrací se plaintext tokenu – jediné místo, kde existuje. V databázi je jen
 * jeho SHA-256.
 */
export async function claimHandoff(params: {
  practice: ResolvedPractice
  tagId: string | null
  code: string
  context: RequestInfo
}): Promise<{ token: string; packageId: string }> {
  const result = await claimInTransaction(params)
  if (!result.ok) throw new HandoffError(result.reason, result.message)
  return { token: result.token, packageId: result.packageId }
}

async function claimInTransaction(params: {
  practice: ResolvedPractice
  tagId: string | null
  code: string
  context: RequestInfo
}): Promise<ClaimResult> {
  return withPractice(params.practice.id, async (db): Promise<ClaimResult> => {
    const zamcene = await db.$queryRaw<
      {
        id: string
        package_id: string
        code_hmac: string
        expires_at: Date
        attempt_count: number
        max_attempts: number
      }[]
    >`
      SELECT id, package_id, code_hmac, expires_at, attempt_count, max_attempts
        FROM handoff_activation
       WHERE practice_id = ${params.practice.id}::uuid
         AND status = 'ACTIVE'
       FOR UPDATE
    `

    const activation = zamcene[0]
    if (!activation) {
      return { ok: false, reason: 'nic-neceka', message: 'Momentálně tu na vás nic nečeká.' }
    }

    if (activation.expires_at <= new Date()) {
      await db.handoffActivation.update({
        where: { id: activation.id },
        data: { status: 'EXPIRED' },
      })
      return {
        ok: false,
        reason: 'vyprselo',
        message: 'Platnost vypršela. Požádejte prosím o nové předání.',
      }
    }

    if (activation.attempt_count >= activation.max_attempts) {
      await db.handoffActivation.update({
        where: { id: activation.id },
        data: { status: 'LOCKED' },
      })
      return {
        ok: false,
        reason: 'zamceno',
        message: 'Příliš mnoho pokusů. Požádejte prosím o nové předání.',
      }
    }

    if (!secretMatches(params.code, activation.code_hmac)) {
      const dalsiPokus = activation.attempt_count + 1
      const zamknout = dalsiPokus >= activation.max_attempts

      await db.handoffActivation.update({
        where: { id: activation.id },
        data: {
          attemptCount: dalsiPokus,
          ...(zamknout ? { status: 'LOCKED' as const } : {}),
        },
      })

      await writeAudit(db, params.practice.id, {
        action: zamknout ? 'HANDOFF_LOCKED' : 'HANDOFF_CODE_FAILED',
        actorType: 'PATIENT',
        packageId: activation.package_id,
        metadata: { activationId: activation.id, pokus: dalsiPokus },
        context: params.context,
      })

      return {
        ok: false,
        reason: zamknout ? 'zamceno' : 'spatny-kod',
        message: zamknout
          ? 'Příliš mnoho pokusů. Požádejte prosím o nové předání.'
          : 'Kód nesouhlasí. Zkontrolujte ho prosím na obrazovce u lékaře.',
      }
    }

    // Kód sedí. Od téhle chvíle je aktivace vyčerpaná – další přiložení
    // telefonu už nic neukáže.
    const token = generateAccessToken()
    const expiresAt = new Date(Date.now() + params.practice.linkTtlDays * 24 * 60 * 60 * 1000)

    const vydany = await db.patientAccessToken.create({
      data: {
        practiceId: params.practice.id,
        packageId: activation.package_id,
        tokenHash: hashToken(token),
        channel: 'NFC',
        // Pacient stál u lékaře a opsal kód z jeho obrazovky, takže další
        // ověření by bylo jen otravné.
        verificationType: 'NONE',
        expiresAt,
      },
      select: { id: true },
    })

    await db.handoffActivation.update({
      where: { id: activation.id },
      data: {
        status: 'CLAIMED',
        claimedAt: new Date(),
        patientAccessTokenId: vydany.id,
        nfcTagId: params.tagId,
      },
    })

    await db.package.update({
      where: { id: activation.package_id },
      data: { status: 'HANDED', expiresAt },
    })

    if (params.tagId) {
      await db.nfcTag.update({
        where: { id: params.tagId },
        data: { lastSeenAt: new Date() },
      })
    }

    await writeAudit(db, params.practice.id, {
      action: 'HANDOFF_CLAIMED',
      actorType: 'PATIENT',
      packageId: activation.package_id,
      tokenId: vydany.id,
      metadata: { activationId: activation.id },
      context: params.context,
    })

    await writeAudit(db, params.practice.id, {
      action: 'TOKEN_ISSUED',
      actorType: 'SYSTEM',
      packageId: activation.package_id,
      tokenId: vydany.id,
      metadata: { kanal: 'NFC', platnostDni: params.practice.linkTtlDays },
      context: params.context,
    })

    return { ok: true, token, packageId: activation.package_id }
  })
}
