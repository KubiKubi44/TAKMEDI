import { getApiUser } from '@/lib/auth'
import { jsonResponse } from '@/lib/http'
import { PackageError, uploadPackageReport } from '@/lib/packages'
import { MAX_FILE_BYTES, PdfError } from '@/lib/pdf'
import { hitRateLimit } from '@/lib/rate-limit'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Nahrání lékařské zprávy k balíčku.
 *
 * Route handler, ne Server Action: ta má strop těla 1 MB a jeho překročení
 * se vyhodí ještě před spuštěním funkce, takže se nedá nahradit srozumitelnou
 * hláškou. Sken z tabletu bývá klidně několik megabajtů.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ packageId: string }> },
): Promise<Response> {
  const session = await getApiUser()
  if (!session) return jsonResponse({ error: 'Přihlášení vypršelo. Načtěte stránku znovu.' }, 401)

  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) {
      return jsonResponse({ error: 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.' }, 403)
    }
    throw error
  }

  const { packageId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(packageId)) {
    return jsonResponse({ error: 'Neplatný balíček.' }, 400)
  }

  const limit = await hitRateLimit({
    action: 'zprava',
    identifier: session.userId,
    limit: 60,
    windowSeconds: 300,
  })
  if (!limit.allowed) {
    return jsonResponse({ error: 'Příliš mnoho nahrávání po sobě. Chvíli počkejte.' }, 429)
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_FILE_BYTES * 1.1) {
    return jsonResponse({ error: `Soubor je větší než ${MAX_FILE_BYTES / 1024 / 1024} MB.` }, 413)
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonResponse({ error: 'Soubor se nepodařilo přijmout. Zkuste to prosím znovu.' }, 400)
  }

  const file = form.get('soubor')
  if (!(file instanceof File) || file.size === 0) {
    return jsonResponse({ error: 'Nebyl vybrán žádný soubor.' }, 400)
  }
  if (file.size > MAX_FILE_BYTES) {
    return jsonResponse({ error: `Soubor je větší než ${MAX_FILE_BYTES / 1024 / 1024} MB.` }, 413)
  }

  const context = await getRequestContext()

  try {
    const result = await uploadPackageReport({
      practiceId: session.user.practiceId,
      userId: session.userId,
      userName: session.user.name,
      packageId,
      bytes: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type || 'application/octet-stream',
      context,
    })

    return jsonResponse(result, 201)
  } catch (error) {
    if (error instanceof PdfError) return jsonResponse({ error: error.message }, 422)
    if (error instanceof PackageError) return jsonResponse({ error: error.message }, 409)

    console.error('[medpredani] nahrání zprávy selhalo', error)
    return jsonResponse({ error: 'Zprávu se nepodařilo uložit. Zkuste to prosím znovu.' }, 500)
  }
}
