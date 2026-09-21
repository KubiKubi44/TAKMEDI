import { canManageLibrary, getApiUser } from '@/lib/auth'
import { jsonResponse } from '@/lib/http'
import { LibraryError, uploadTemplateVersion } from '@/lib/library-documents'
import { MAX_FILE_BYTES, PdfError } from '@/lib/pdf'
import { hitRateLimit } from '@/lib/rate-limit'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Nahrání dokumentu do knihovny.
 *
 * Proč route handler a ne Server Action: Server Actions mají výchozí strop
 * těla 1 MB a jeho překročení se vyhodí při dekódování ještě PŘED spuštěním
 * vlastní funkce, takže se nedá odchytit ani nahradit srozumitelnou hláškou –
 * ven jde holá pětistovka. Tady si limit hlídáme sami.
 *
 * Cesty pod /api jsou zároveň vyňaté z proxy (viz src/proxy.ts). Kdyby je
 * proxy chytala, Next by tělo nabufferoval s vlastním limitem a přes něj
 * by nahraný soubor MLČKY usekl.
 */

export async function POST(request: Request): Promise<Response> {
  // Ne requireUser(): ten přesměrovává na přihlášení, takže by volající přes
  // fetch dostal HTML se stavem 200 místo srozumitelné odpovědi.
  const session = await getApiUser()
  if (!session) {
    return jsonResponse({ error: 'Přihlášení vypršelo. Načtěte stránku znovu.' }, 401)
  }

  if (!canManageLibrary(session.user)) {
    return jsonResponse({ error: 'K úpravám knihovny nemáte oprávnění.' }, 403)
  }

  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) {
      return jsonResponse({ error: 'Požadavek nepřišel z této aplikace. Načtěte stránku znovu.' }, 403)
    }
    throw error
  }

  const limit = await hitRateLimit({
    action: 'upload',
    identifier: session.userId,
    limit: 60,
    windowSeconds: 300,
  })
  if (!limit.allowed) {
    return jsonResponse({ error: 'Příliš mnoho nahrávání po sobě. Chvíli počkejte.' }, 429)
  }

  // Deklarovaná délka se kontroluje dřív, než se tělo vůbec načte do paměti.
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

  const problemId = asString(form.get('problemId'))
  const documentId = asString(form.get('documentId'))
  const title = asString(form.get('nazev'))?.slice(0, 200)

  if (!problemId && !documentId) {
    return jsonResponse({ error: 'Není řečeno, kam dokument patří.' }, 400)
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const context = await getRequestContext()

  try {
    const result = await uploadTemplateVersion({
      practiceId: session.user.practiceId,
      userId: session.userId,
      userName: session.user.name,
      problemId,
      documentId,
      // Název z formuláře, jinak název souboru bez přípony.
      title: title || fallbackTitle(file.name),
      bytes,
      mimeType: file.type || 'application/octet-stream',
      context,
    })

    return jsonResponse(result, 201)
  } catch (error) {
    // Vadný soubor a souběh při verzování jsou běžné situace, ne porucha –
    // uživatel má dostat větu, která mu řekne, co s tím.
    if (error instanceof PdfError) return jsonResponse({ error: error.message }, 422)
    if (error instanceof LibraryError) return jsonResponse({ error: error.message }, 409)

    console.error('[medpredani] nahrání dokumentu selhalo', error)
    return jsonResponse({ error: 'Dokument se nepodařilo uložit. Zkuste to prosím znovu.' }, 500)
  }
}

function asString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function fallbackTitle(filename: string): string {
  const bezPripony = filename.replace(/\.[^.]+$/, '').trim()
  return bezPripony.slice(0, 200) || 'Dokument'
}
