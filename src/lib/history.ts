import 'server-only'

import type { PackageStatus, TokenChannel } from '@/generated/prisma/enums'
import { decryptOptional } from './crypto'
import type { TenantClient } from './db'

/**
 * Historie předaných balíčků a auditní deník.
 *
 * Hledat podle jména pacienta nejde a je to vědomá cena: jméno se ukládá
 * zašifrované, takže by se muselo dešifrovat všechno a porovnávat v paměti.
 * Filtruje se proto podle data, problému, uživatele a kanálu – a jméno se
 * dešifruje až u řádků, které projdou.
 */

export type HistoryFilter = {
  od?: Date
  do?: Date
  problemId?: string
  createdById?: string
  status?: PackageStatus
  limit?: number
  offset?: number
}

export type HistoryItem = {
  id: string
  createdAt: Date
  status: PackageStatus
  problemName: string | null
  patientLabel: string | null
  createdByName: string
  documentCount: number
  /** Kanály, kterými balíček odešel. Prázdné pole = zatím nepředaný. */
  channels: TokenChannel[]
  printed: boolean
  expiresAt: Date | null
  /** Pacient si aspoň jednou otevřel odkaz. */
  opened: boolean
  /** Platný odkaz, který jde zneplatnit. */
  hasLiveLink: boolean
}

export async function listHistory(
  db: TenantClient,
  filter: HistoryFilter = {},
): Promise<{ items: HistoryItem[]; total: number }> {
  const where = {
    // Rozpracované (DRAFT) i jen připravené (READY) balíčky do historie
    // nepatří – nic se s nimi nestalo. Tisk i každý jiný kanál nastavují HANDED.
    status: filter.status ?? { notIn: ['DRAFT', 'READY'] as PackageStatus[] },
    ...(filter.od || filter.do
      ? { createdAt: { ...(filter.od ? { gte: filter.od } : {}), ...(filter.do ? { lte: filter.do } : {}) } }
      : {}),
    ...(filter.problemId ? { problemId: filter.problemId } : {}),
    ...(filter.createdById ? { createdById: filter.createdById } : {}),
  }

  const [rows, total] = await Promise.all([
    db.package.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 50,
      skip: filter.offset ?? 0,
      select: {
        id: true,
        createdAt: true,
        status: true,
        expiresAt: true,
        patientLabelEnc: true,
        problem: { select: { name: true } },
        createdBy: { select: { name: true } },
        _count: { select: { documents: true } },
        tokens: {
          select: { channel: true, revokedAt: true, expiresAt: true, accessCount: true },
        },
      },
    }),
    db.package.count({ where }),
  ])

  // Tisk se nepozná z balíčku, jen z auditu – proto samostatný dotaz.
  const vytistene = new Set(
    (
      await db.auditLog.findMany({
        where: { action: 'PACKAGE_PRINTED', packageId: { in: rows.map((r) => r.id) } },
        select: { packageId: true },
      })
    )
      .map((z) => z.packageId)
      .filter((id): id is string => id !== null),
  )

  const now = new Date()

  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      status: row.status,
      problemName: row.problem?.name ?? null,
      patientLabel: decryptOptional(row.patientLabelEnc),
      createdByName: row.createdBy.name,
      documentCount: row._count.documents,
      channels: [...new Set(row.tokens.map((t) => t.channel))],
      printed: vytistene.has(row.id),
      expiresAt: row.expiresAt,
      opened: row.tokens.some((t) => t.accessCount > 0),
      hasLiveLink: row.tokens.some((t) => !t.revokedAt && t.expiresAt > now),
    })),
  }
}

export type AuditEntryView = {
  id: string
  seq: string | null
  createdAt: Date
  action: string
  actorType: string
  actorName: string | null
  packageId: string | null
  ip: string | null
  metadata: unknown
}

/** Auditní deník ordinace. Vidí ho lékař a admin, ne sestra. */
export async function listAudit(
  db: TenantClient,
  params: { packageId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: AuditEntryView[]; total: number }> {
  const where = params.packageId ? { packageId: params.packageId } : {}

  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: params.limit ?? 100,
      skip: params.offset ?? 0,
    }),
    db.auditLog.count({ where }),
  ])

  return {
    total,
    items: rows.map((row) => ({
      // BigInt se do klientské komponenty neposílá – neprojde serializací.
      id: row.id.toString(),
      seq: row.seq?.toString() ?? null,
      createdAt: row.createdAt,
      action: row.action,
      actorType: row.actorType,
      actorName: row.actorName,
      packageId: row.packageId,
      ip: row.ip,
      metadata: row.metadata,
    })),
  }
}

/**
 * Ověří, že hashový řetěz auditu nebyl porušen.
 *
 * Neměnnost hlídají granty i trigger, ale tohle je nezávislý důkaz: kdyby
 * někdo sáhl do databáze mimo aplikaci, řetěz se rozpadne a je vidět kde.
 */
export async function verifyAuditChain(
  db: TenantClient,
  practiceId: string,
): Promise<{ ok: boolean; zkontrolovano: number; prvniChyba: string | null }> {
  const rows = await db.auditLog.findMany({
    where: { practiceId, seq: { not: null } },
    orderBy: { seq: 'asc' },
    select: { seq: true, hash: true, prevHash: true },
  })

  let ocekavanyPredchozi: string | null = null
  let ocekavaneSeq = 1n

  for (const row of rows) {
    if (row.seq !== ocekavaneSeq) {
      return {
        ok: false,
        zkontrolovano: rows.length,
        prvniChyba: `chybí záznam číslo ${ocekavaneSeq} (nalezen ${row.seq})`,
      }
    }
    if (row.prevHash !== ocekavanyPredchozi) {
      return {
        ok: false,
        zkontrolovano: rows.length,
        prvniChyba: `záznam číslo ${row.seq} nenavazuje na předchozí`,
      }
    }
    ocekavanyPredchozi = row.hash
    ocekavaneSeq += 1n
  }

  return { ok: true, zkontrolovano: rows.length, prvniChyba: null }
}
