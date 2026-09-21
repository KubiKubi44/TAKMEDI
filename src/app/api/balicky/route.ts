import { z } from 'zod'

import { getApiUser } from '@/lib/auth'
import { jsonResponse } from '@/lib/http'
import {
  createDraftPackage,
  PackageError,
  setPackageDocuments,
  type PackageDocumentInput,
} from '@/lib/packages'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Založení a úpravy rozpracovaného balíčku.
 *
 * Identifikátory dokumentů chodí z prohlížeče, takže se jim nevěří: že patří
 * téhle ordinaci, se ověří dohledáním pod row-level security, ne kontrolou
 * v tomhle souboru.
 */

const VytvoritSchema = z.object({
  problemId: z.uuid().optional(),
})

const UpravitSchema = z.object({
  packageId: z.uuid(),
  documents: z
    .array(
      z.union([
        z.object({ kind: z.literal('TEMPLATE'), templateVersionId: z.uuid() }),
        z.object({ kind: z.literal('UPLOAD'), uploadedFileId: z.uuid() }),
      ]),
    )
    .max(50, { error: 'Balíček může mít nejvýš 50 dokumentů.' }),
  patientLabel: z.string().max(120).nullish(),
  note: z.string().max(500).nullish(),
  /** Nepovinné – posílá se, když lékař vybere problém až po nahrání zprávy. */
  problemId: z.uuid().nullish(),
})

export async function POST(request: Request): Promise<Response> {
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

  const telo: unknown = await request.json().catch(() => null)
  const parsed = VytvoritSchema.safeParse(telo ?? {})
  if (!parsed.success) return jsonResponse({ error: 'Neplatný požadavek.' }, 400)

  const context = await getRequestContext()

  const packageId = await createDraftPackage({
    practiceId: session.user.practiceId,
    userId: session.userId,
    userName: session.user.name,
    problemId: parsed.data.problemId,
    context,
  })

  return jsonResponse({ packageId }, 201)
}

export async function PUT(request: Request): Promise<Response> {
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

  const telo: unknown = await request.json().catch(() => null)
  const parsed = UpravitSchema.safeParse(telo)
  if (!parsed.success) {
    const tree = z.treeifyError(parsed.error)
    return jsonResponse({ error: tree.errors[0] ?? 'Neplatný požadavek.' }, 400)
  }

  const context = await getRequestContext()

  try {
    const view = await setPackageDocuments({
      practiceId: session.user.practiceId,
      userId: session.userId,
      userName: session.user.name,
      packageId: parsed.data.packageId,
      items: parsed.data.documents as PackageDocumentInput[],
      patientLabel: parsed.data.patientLabel ?? null,
      note: parsed.data.note ?? null,
      problemId: parsed.data.problemId === undefined ? undefined : parsed.data.problemId,
      context,
    })

    return jsonResponse(view)
  } catch (error) {
    if (error instanceof PackageError) return jsonResponse({ error: error.message }, 409)

    console.error('[medpredani] úprava balíčku selhala', error)
    return jsonResponse({ error: 'Balíček se nepodařilo uložit. Zkuste to prosím znovu.' }, 500)
  }
}
