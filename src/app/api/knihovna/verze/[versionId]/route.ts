import { getApiUser } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { withPractice } from '@/lib/db'
import { notFoundResponse, pdfResponse } from '@/lib/http'
import { readTemplateVersion } from '@/lib/library-documents'
import { getRequestContext } from '@/lib/request-context'

/**
 * Náhled a stažení dokumentu z knihovny pro personál ordinace.
 *
 * Obsah teče PŘES aplikaci, ne přes podepsané URL z úložiště. Díky tomu se
 * v auditu objeví skutečné stažení (ne jen vydání odkazu), odvolání platí
 * okamžitě a soubory můžou být šifrované aplikačním klíčem, takže do nich
 * poskytovatel úložiště nevidí.
 *
 * Neexistující i cizí dokument vracejí stejnou odpověď – ven se nesmí dostat
 * ani informace o tom, že něco takového v jiné ordinaci existuje.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string }> },
): Promise<Response> {
  // Neexistující dokument, cizí dokument i chybějící přihlášení vracejí totéž.
  // Ven se nesmí dostat ani informace o tom, že něco takového existuje.
  const session = await getApiUser()
  if (!session) return notFoundResponse()

  const { versionId } = await params

  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return notFoundResponse()

  const context = await getRequestContext()

  const version = await withPractice(session.user.practiceId, async (db) => {
    const found = await readTemplateVersion(db, versionId)
    if (!found) return null

    await writeAudit(db, session.user.practiceId, {
      action: 'DOCUMENT_DOWNLOADED',
      actorType: 'USER',
      actorUserId: session.userId,
      actorName: session.user.name,
      documentId: versionId,
      metadata: { kde: 'knihovna' },
      context,
    })

    return found
  })

  if (!version) return notFoundResponse()

  return pdfResponse({
    bytes: version.bytes,
    filename: `${version.title}.pdf`,
    inline: true,
  })
}
