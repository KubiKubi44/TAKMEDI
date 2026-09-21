import { writeAudit } from '@/lib/audit'
import { withPractice } from '@/lib/db'
import { notFoundResponse, pdfResponse } from '@/lib/http'
import { openPatientPackage, PatientAccessError, readPatientDocument } from '@/lib/patient'
import { getRequestContext } from '@/lib/request-context'

/**
 * Stažení jednoho dokumentu pacientem.
 *
 * Obsah teče přes aplikaci, ne přes podepsané URL z úložiště – jen tak se dá
 * zapsat SKUTEČNÉ stažení (ne jen vydání odkazu) a odvolání platí okamžitě.
 *
 * Každý důvod odmítnutí vypadá ven stejně: neplatný token, vypršelý, cizí
 * dokument i neověřený přístup vracejí 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; dokumentId: string }> },
): Promise<Response> {
  const { token, dokumentId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(dokumentId)) return notFoundResponse()

  const context = await getRequestContext()

  try {
    const balicek = await openPatientPackage(token, context)
    // Dokud pacient neprošel ověřením, nedostane ani jednotlivý soubor.
    if (balicek.needsVerification) return notFoundResponse()

    const dokument = await withPractice(balicek.practiceId, async (db) => {
      const nalezeny = await readPatientDocument(db, balicek.packageId, dokumentId)
      if (!nalezeny) return null

      await writeAudit(db, balicek.practiceId, {
        action: 'DOCUMENT_DOWNLOADED',
        actorType: 'PATIENT',
        packageId: balicek.packageId,
        tokenId: balicek.tokenId,
        documentId: dokumentId,
        metadata: { kde: 'pacient', nazev: nalezeny.title },
        context,
      })

      return nalezeny
    })

    if (!dokument) return notFoundResponse()

    return pdfResponse({ bytes: dokument.bytes, filename: `${dokument.title}.pdf` })
  } catch (error) {
    if (error instanceof PatientAccessError) return notFoundResponse()
    throw error
  }
}
