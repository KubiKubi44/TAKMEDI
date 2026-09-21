import 'server-only'

import type { ActorType, AuditAction } from '@/generated/prisma/enums'
import { resolverClient, type TenantClient } from './db'
import { tryGetRequestContext, type RequestInfo } from './request-context'

/**
 * Zápis do auditního deníku.
 *
 * Tabulka je přidávací: aplikační role na ni má jen INSERT a SELECT a nad ní
 * ještě hlídá trigger, který odmítne UPDATE, DELETE i TRUNCATE. Pořadí a
 * hashový řetěz doplňuje databáze sama – sloupce seq, prevHash a hash se odsud
 * nikdy neposílají.
 *
 * Existují dvě cesty zápisu a NEJSOU zaměnitelné:
 *
 *  writeAudit          – událost patřící ordinaci. Musí jít přes aplikační roli
 *                        uvnitř withPractice(). Rozlišovací role by tady
 *                        neuspěla hned dvakrát: Prisma vydá INSERT ... RETURNING,
 *                        na což nemá právo SELECT, a navíc funkce řetězu čte
 *                        poslední záznam ordinace, k čemuž taky potřebuje SELECT.
 *
 *  writeAnonymousAudit – událost bez ordinace, typicky pokus o přihlášení na
 *                        neznámý e-mail. Zapisuje rozlišovací role a musí použít
 *                        createMany, protože ten jediný vydá INSERT bez RETURNING.
 */

export type AuditEntry = {
  action: AuditAction
  actorType: ActorType
  actorUserId?: string | null
  /** Jméno opsané v okamžiku zápisu – log zůstane čitelný i po smazání účtu. */
  actorName?: string | null
  packageId?: string | null
  tokenId?: string | null
  documentId?: string | null
  metadata?: Record<string, unknown>
  /**
   * IP a prohlížeč. Když se nepředají, zkusí se přečíst z požadavku – mimo
   * obsluhu požadavku (úklidová úloha, test) zůstanou prázdné.
   */
  context?: RequestInfo
}

/**
 * Zapíše událost patřící ordinaci.
 *
 * Předává se transakční klient z withPractice() – zápis tak proběhne ve stejné
 * transakci jako změna, kterou popisuje. Když se změna vrátí zpět, vrátí se
 * i audit a v deníku nezůstane záznam o něčem, co se nestalo.
 */
export async function writeAudit(
  db: TenantClient,
  practiceId: string,
  entry: AuditEntry,
): Promise<void> {
  const { ip, userAgent } = entry.context ?? (await tryGetRequestContext())

  await db.auditLog.create({
    data: {
      practiceId,
      action: entry.action,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      actorName: entry.actorName ?? null,
      packageId: entry.packageId ?? null,
      tokenId: entry.tokenId ?? null,
      documentId: entry.documentId ?? null,
      ip,
      userAgent,
      metadata: (entry.metadata ?? {}) as never,
    },
  })
}

/**
 * Zapíše událost, ke které se ordinace nedá přiřadit.
 *
 * Takové záznamy se neřetězí – rozlišovací role nesmí číst cizí záznamy, takže
 * by na předchozí hash nedosáhla. Nese to s sebou, že tahle část deníku nemá
 * důkaz o neporušenosti pořadí; jsou v ní ale jen události bez vazby na
 * pacienta ani na ordinaci.
 */
export async function writeAnonymousAudit(entry: AuditEntry): Promise<void> {
  const { ip, userAgent } = entry.context ?? (await tryGetRequestContext())

  await resolverClient.auditLog.createMany({
    data: [
      {
        practiceId: null,
        action: entry.action,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        actorName: entry.actorName ?? null,
        packageId: entry.packageId ?? null,
        tokenId: entry.tokenId ?? null,
        documentId: entry.documentId ?? null,
        ip,
        userAgent,
        metadata: (entry.metadata ?? {}) as never,
      },
    ],
  })
}
