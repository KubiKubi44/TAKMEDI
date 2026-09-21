import { getApiUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { getActivationStatus } from '@/lib/handoff'
import { jsonResponse } from '@/lib/http'

/**
 * Stav aktivace pro obrazovku lékaře.
 *
 * Ptá se na něj každé dvě sekundy, dokud běží okno. Je to schválně dotazování
 * a ne trvalé spojení: tři minuty krát jeden dotaz za dvě sekundy je devadesát
 * požadavků, což je proti složitosti a křehkosti trvalého spojení nic.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ activationId: string }> },
): Promise<Response> {
  const session = await getApiUser()
  if (!session) return jsonResponse({ error: 'Přihlášení vypršelo.' }, 401)

  const { activationId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(activationId)) return jsonResponse({ error: 'Nenalezeno.' }, 404)

  const stav = await withPractice(session.user.practiceId, (db) =>
    getActivationStatus(db, activationId),
  )

  if (!stav) return jsonResponse({ error: 'Nenalezeno.' }, 404)

  return jsonResponse({
    status: stav.status,
    expiresAt: stav.expiresAt.toISOString(),
    attemptsLeft: stav.attemptsLeft,
  })
}
