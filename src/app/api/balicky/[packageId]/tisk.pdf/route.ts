import { getApiUser } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { withPractice } from '@/lib/db'
import { notFoundResponse, pdfResponse } from '@/lib/http'
import { buildPackagePdf, loadPackage, PackageError } from '@/lib/packages'
import { getRequestContext } from '@/lib/request-context'

/**
 * Sloučený balíček k tisku.
 *
 * Vrací se s dispozicí „inline", aby ho prohlížeč zobrazil ve skrytém rámu
 * a rovnou otevřel tiskový dialog – lékař nemá nic stahovat ani otevírat ručně.
 *
 * Slučování běží v odděleném vlákně (viz src/lib/pdf.ts), takže ani větší
 * balíček nezablokuje obsluhu ostatních požadavků.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ packageId: string }> },
): Promise<Response> {
  const session = await getApiUser()
  if (!session) return notFoundResponse()

  const { packageId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(packageId)) return notFoundResponse()

  const context = await getRequestContext()

  try {
    const { bytes, nazev } = await withPractice(session.user.practiceId, async (db) => {
      const view = await loadPackage(db, packageId)
      // Cizí balíček row-level security nevrátí, takže se chová stejně jako
      // neexistující. Ven nejde ani náznak, že někde jinde je.
      if (!view) return { bytes: null, nazev: '' }

      const merged = await buildPackagePdf(db, packageId)

      await writeAudit(db, session.user.practiceId, {
        action: 'PACKAGE_PRINTED',
        actorType: 'USER',
        actorUserId: session.userId,
        actorName: session.user.name,
        packageId,
        metadata: { pocetDokumentu: view.documents.length, stran: view.totalPages },
        context,
      })

      // Tisk je předání. Bez tohohle by balíček zůstal ve stavu READY,
      // v historii by vypadal jako nikdy nepředaný a úklid by nevěděl,
      // kdy nahranou zprávu smazat.
      const stavajici = await db.package.findUniqueOrThrow({
        where: { id: packageId },
        select: { expiresAt: true, practice: { select: { linkTtlDays: true } } },
      })
      await db.package.update({
        where: { id: packageId },
        data: {
          status: 'HANDED',
          ...(stavajici.expiresAt
            ? {}
            : { expiresAt: new Date(Date.now() + stavajici.practice.linkTtlDays * 24 * 60 * 60 * 1000) }),
        },
      })

      return { bytes: merged, nazev: view.problemName ?? 'Dokumenty pro pacienta' }
    }, { timeoutMs: 60_000 })

    if (!bytes) return notFoundResponse()

    return pdfResponse({ bytes, filename: `${nazev}.pdf`, inline: true })
  } catch (error) {
    if (error instanceof PackageError) {
      return new Response(error.message, {
        status: 409,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    throw error
  }
}
