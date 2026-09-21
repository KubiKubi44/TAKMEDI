import { getApiUser } from '@/lib/auth'
import { cancelActivation } from '@/lib/handoff'
import { jsonResponse } from '@/lib/http'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/** Lékař předání zruší – například když pacient odejde dřív. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ activationId: string }> },
): Promise<Response> {
  const session = await getApiUser()
  if (!session) return jsonResponse({ error: 'Přihlášení vypršelo.' }, 401)

  try {
    await requireTrustedOrigin()
  } catch (error) {
    if (error instanceof CrossOriginError) {
      return jsonResponse({ error: 'Požadavek nepřišel z této aplikace.' }, 403)
    }
    throw error
  }

  const { activationId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(activationId)) return jsonResponse({ error: 'Nenalezeno.' }, 404)

  const zruseno = await cancelActivation({
    practiceId: session.user.practiceId,
    activationId,
    userId: session.userId,
    userName: session.user.name,
    context: await getRequestContext(),
  })

  // Když se nezrušilo, pacient to nejspíš stihl o vteřinu dřív. Obrazovka se
  // podle toho musí zeptat na skutečný stav, ne předpokládat zrušení.
  return jsonResponse({ ok: true, zruseno })
}
