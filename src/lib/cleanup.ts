import 'server-only'

import { writeAudit } from './audit'
import { appClient, resolverClient, withPractice } from './db'
import { purgeExpiredRateLimits } from './rate-limit'
import { purgeExpiredSessions } from './session'
import { storage } from './storage'

/**
 * Úklid po expiraci.
 *
 * Nejde o úsporu místa, ale o slib daný pacientovi: po uplynutí platnosti se
 * dokumenty smažou. Proto se maže OBSAH v úložišti a osobní pole v databázi,
 * zatímco metadata a audit zůstávají – kdy, kdo a jakým kanálem předal, se
 * dohledat musí, ale co přesně pacient dostal, už ne.
 *
 * Úloha musí jít spustit opakovaně, aniž by cokoli pokazila: běží z cronu
 * a při výpadku se prostě spustí znovu.
 */

export type CleanupReport = {
  balicku: number
  souboru: number
  tokenu: number
  aktivaci: number
  relaci: number
  pocitadel: number
  chyby: string[]
}

/**
 * Seznam ordinací se čte rolí, která nemá kontext ordinace.
 *
 * Aplikační role bez nastaveného app.practice_id nevidí nic – to je záměr.
 * Úklid ale musí projít všechny ordinace, takže si nejdřív vyžádá jejich
 * identifikátory a pak pro každou zvlášť otevře její kontext.
 */
async function listPracticeIds(): Promise<string[]> {
  const rows = await resolverClient.practice.findMany({ select: { id: true } })
  return rows.map((r) => r.id)
}

export async function runCleanup(now = new Date()): Promise<CleanupReport> {
  const report: CleanupReport = {
    balicku: 0,
    souboru: 0,
    tokenu: 0,
    aktivaci: 0,
    relaci: 0,
    pocitadel: 0,
    chyby: [],
  }

  for (const practiceId of await listPracticeIds()) {
    try {
      const dilci = await cleanupPractice(practiceId, now)
      report.balicku += dilci.balicku
      report.souboru += dilci.souboru
      report.tokenu += dilci.tokenu
      report.aktivaci += dilci.aktivaci
    } catch (error) {
      // Chyba v jedné ordinaci nesmí zastavit úklid ostatních.
      report.chyby.push(
        `ordinace ${practiceId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  report.relaci = await purgeExpiredSessions()
  report.pocitadel = await purgeExpiredRateLimits()

  return report
}

async function cleanupPractice(
  practiceId: string,
  now: Date,
): Promise<{ balicku: number; souboru: number; tokenu: number; aktivaci: number }> {
  // Krok 1: co je po expiraci. Čte se mimo mazací transakci, protože mazání
  // v úložišti je síťová operace a transakce má být krátká.
  const balicky = await withPractice(practiceId, (db) =>
    db.package.findMany({
      where: { expiresAt: { lt: now }, purgedAt: null },
      select: {
        id: true,
        uploads: {
          where: { deletedAt: null },
          select: { id: true, storageKey: true },
        },
      },
    }),
  )

  let souboru = 0
  const ulozene = await storage()

  for (const balicek of balicky) {
    for (const soubor of balicek.uploads) {
      // Chybějící obsah není chyba – úloha musí jít spustit znovu.
      await ulozene.delete(soubor.storageKey)
      souboru += 1
    }

    await withPractice(practiceId, async (db) => {
      await db.uploadedFile.updateMany({
        where: { packageId: balicek.id, deletedAt: null },
        data: { deletedAt: now },
      })

      await db.patientAccessToken.updateMany({
        where: { packageId: balicek.id, revokedAt: null },
        data: { revokedAt: now },
      })

      // Adresa příjemce už není k ničemu; pro audit zůstává její hash.
      await db.emailDispatch.updateMany({
        where: { packageId: balicek.id },
        data: { recipientEnc: Buffer.alloc(0) },
      })

      await db.package.update({
        where: { id: balicek.id },
        data: {
          status: 'EXPIRED',
          purgedAt: now,
          // Osobní údaje mizí spolu s obsahem. V historii zůstane, že se
          // něco předalo, ale ne komu.
          patientLabelEnc: null,
          noteEnc: null,
        },
      })

      await writeAudit(db, practiceId, {
        action: 'FILES_PURGED',
        actorType: 'SYSTEM',
        packageId: balicek.id,
        metadata: { souboru: balicek.uploads.length },
      })
    })
  }

  // Krok 2: rozpracované balíčky, ze kterých nic nebylo. Bez tohohle by
  // historie zarostla prázdnými záznamy z každého překliknutí.
  const starsiNezDen = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const opustene = await withPractice(practiceId, async (db) => {
    const kandidati = await db.package.findMany({
      where: { status: 'DRAFT', createdAt: { lt: starsiNezDen } },
      select: { id: true, uploads: { select: { storageKey: true } } },
    })

    return kandidati
  })

  for (const balicek of opustene) {
    for (const soubor of balicek.uploads) {
      await ulozene.delete(soubor.storageKey)
      souboru += 1
    }
  }

  const smazano = await withPractice(practiceId, async (db) => {
    if (opustene.length === 0) return 0
    const { count } = await db.package.deleteMany({
      where: { id: { in: opustene.map((b) => b.id) }, status: 'DRAFT' },
    })
    return count
  })

  // Krok 3: aktivace, kterým uplynulo okno. Zůstávají jako doklad, jen
  // přestanou být otevřené.
  const aktivaci = await withPractice(practiceId, async (db) => {
    const { count } = await db.handoffActivation.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    })
    return count
  })

  const tokenu = await withPractice(practiceId, async (db) => {
    const { count } = await db.patientAccessToken.updateMany({
      where: { expiresAt: { lt: now }, revokedAt: null },
      data: { revokedAt: now },
    })
    return count
  })

  return { balicku: balicky.length + smazano, souboru, tokenu, aktivaci }
}

/** Ručně vyvolané zneplatnění odkazu – tlačítko „Zneplatnit" v historii. */
export async function revokePackageLinks(params: {
  practiceId: string
  packageId: string
  userId: string
  userName: string
  context: { ip: string | null; userAgent: string | null }
}): Promise<number> {
  return withPractice(params.practiceId, async (db) => {
    const { count } = await db.patientAccessToken.updateMany({
      where: { packageId: params.packageId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: params.userId },
    })

    if (count === 0) return 0

    await db.package.update({
      where: { id: params.packageId },
      data: { status: 'REVOKED' },
    })

    await writeAudit(db, params.practiceId, {
      action: 'TOKEN_REVOKED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      packageId: params.packageId,
      metadata: { zneplatneno: count },
      context: params.context,
    })

    return count
  })
}

export async function disconnectCleanup(): Promise<void> {
  await Promise.all([appClient.$disconnect(), resolverClient.$disconnect()])
}
