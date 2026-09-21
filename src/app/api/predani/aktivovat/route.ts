import { z } from 'zod'

import { getApiUser } from '@/lib/auth'
import { activateHandoff, HandoffError } from '@/lib/handoff'
import { jsonResponse } from '@/lib/http'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/** Otevře okno pro přiložení telefonu a vrátí kód, který lékař ukáže pacientovi. */
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
  const parsed = z.object({ packageId: z.uuid() }).safeParse(telo)
  if (!parsed.success) return jsonResponse({ error: 'Neplatný požadavek.' }, 400)

  const context = await getRequestContext()

  try {
    const aktivace = await activateHandoff({
      practiceId: session.user.practiceId,
      packageId: parsed.data.packageId,
      userId: session.userId,
      userName: session.user.name,
      context,
    })

    // Kód jde ven JEDINKRÁT, sem. V databázi je z něj jen HMAC s pepperem,
    // který je uložený mimo ni.
    return jsonResponse(
      {
        activationId: aktivace.id,
        code: aktivace.code,
        expiresAt: aktivace.expiresAt.toISOString(),
      },
      201,
    )
  } catch (error) {
    if (error instanceof HandoffError) return jsonResponse({ error: error.message }, 409)

    console.error('[medpredani] aktivace předání selhala', error)
    return jsonResponse({ error: 'Předání se nepodařilo spustit. Zkuste to prosím znovu.' }, 500)
  }
}
