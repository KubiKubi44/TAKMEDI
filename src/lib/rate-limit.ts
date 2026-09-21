import 'server-only'

import { hmacSecret } from './crypto'
import { resolverClient } from './db'

/**
 * Omezování četnosti pokusů.
 *
 * Počítadla žijí v PostgreSQL, ne v Redisu – provoz je řádově desítky akcí
 * denně a tohle nepřidává do infrastruktury ani do zpracovatelských smluv
 * další službu.
 *
 * Běží pod rozlišovací rolí, protože se používá i tam, kde ordinace ještě není
 * známá: při přihlašování a na veřejných pacientských stránkách.
 */

export type RateLimitResult = {
  allowed: boolean
  /** Kolik pokusů v okně už proběhlo, včetně tohoto. */
  count: number
  retryAfterSeconds: number
}

/**
 * Zvýší počítadlo a řekne, jestli se akce smí provést.
 *
 * Posuvné okno se NEDÁ napsat přes prisma.upsert – jeho `update` umí jen
 * bezpodmínečný přírůstek, takže by reset okna vyžadoval dva dotazy a mezi ně
 * by se vešel souběžný pokus. Tenhle jediný příkaz je atomický i při souběhu.
 *
 * Identifikátor se ukládá jen jako HMAC: tabulka tak neobsahuje e-maily ani
 * IP adresy v čitelné podobě.
 */
export async function hitRateLimit(params: {
  action: string
  identifier: string
  limit: number
  windowSeconds: number
}): Promise<RateLimitResult> {
  const key = hmacSecret(`${params.action}:${params.identifier}`)

  const rows = await resolverClient.$queryRaw<{ count: number; retry_after: number }[]>`
    INSERT INTO rate_limit (key, count, window_start, expires_at)
    VALUES (
      ${key},
      1,
      now(),
      now() + (${params.windowSeconds} * interval '1 second')
    )
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limit.expires_at <= now() THEN 1
        ELSE rate_limit.count + 1
      END,
      window_start = CASE
        WHEN rate_limit.expires_at <= now() THEN now()
        ELSE rate_limit.window_start
      END,
      expires_at = CASE
        WHEN rate_limit.expires_at <= now()
        THEN now() + (${params.windowSeconds} * interval '1 second')
        ELSE rate_limit.expires_at
      END
    RETURNING
      count,
      ceil(extract(epoch FROM (expires_at - now())))::int AS retry_after
  `

  const row = rows[0]
  if (!row) {
    // Nemělo by nastat – RETURNING vrací vždy jeden řádek. Kdyby ano,
    // chováme se opatrně a akci nepustíme.
    return { allowed: false, count: params.limit, retryAfterSeconds: params.windowSeconds }
  }

  return {
    allowed: row.count <= params.limit,
    count: row.count,
    retryAfterSeconds: Math.max(0, row.retry_after),
  }
}

/** Vynuluje počítadlo – volá se po úspěšné akci, aby poctivce netrestalo. */
export async function clearRateLimit(action: string, identifier: string): Promise<void> {
  const key = hmacSecret(`${action}:${identifier}`)
  await resolverClient.rateLimit.deleteMany({ where: { key } })
}

/** Úklid vypršelých počítadel. Volá ho denní úloha. */
export async function purgeExpiredRateLimits(): Promise<number> {
  const result = await resolverClient.rateLimit.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}
