import { writeAudit } from '@/lib/audit'
import { withPractice } from '@/lib/db'
import { notFoundResponse, pdfResponse } from '@/lib/http'
import { buildPatientPdf, openPatientPackage, PatientAccessError } from '@/lib/patient'
import { getRequestContext } from '@/lib/request-context'

/**
 * Celý balíček jako jedno PDF.
 *
 * Skládá se při každém stažení znovu a nikam se neukládá: uložená kopie by
 * byla čtvrtý výskyt téže zdravotní dokumentace navíc, který by se musel
 * hlídat a mazat. Slučování běží v odděleném vlákně, takže neblokuje ostatní.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  const context = await getRequestContext()

  try {
    const balicek = await openPatientPackage(token, context)
    if (balicek.needsVerification) return notFoundResponse()
    if (balicek.documents.length === 0) return notFoundResponse()

    const bytes = await withPractice(
      balicek.practiceId,
      async (db) => {
        const merged = await buildPatientPdf(db, balicek.packageId)

        await writeAudit(db, balicek.practiceId, {
          action: 'DOCUMENT_DOWNLOADED',
          actorType: 'PATIENT',
          packageId: balicek.packageId,
          tokenId: balicek.tokenId,
          metadata: { kde: 'pacient', co: 'vse-v-jednom', stran: balicek.totalPages },
          context,
        })

        return merged
      },
      { timeoutMs: 60_000 },
    )

    return pdfResponse({
      bytes,
      filename: `Dokumenty - ${balicek.practiceName}.pdf`,
    })
  } catch (error) {
    if (error instanceof PatientAccessError) return notFoundResponse()
    throw error
  }
}
