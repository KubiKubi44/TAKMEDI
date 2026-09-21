import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Hlavicka } from '@/components/hlavicka'
import { Card } from '@/components/ui'
import { requireRole } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { getProblemDetail } from '@/lib/library'
import { UpravitForm } from './formular'

export const metadata: Metadata = {
  title: 'Úprava problému – MedPředání',
}

/**
 * Úprava založeného problému.
 *
 * Bez téhle obrazovky by překlep v názvu nebo špatný kód MKN-10 nešlo spravit
 * a v knihovně by navždy zůstal špatně pojmenovaný problém.
 */
export default async function UpravitProblemPage({
  params,
}: {
  params: Promise<{ problemId: string }>
}) {
  const session = await requireRole('DOCTOR', 'PRACTICE_ADMIN')
  const { problemId } = await params

  if (!/^[0-9a-f-]{36}$/i.test(problemId)) notFound()

  const detail = await withPractice(session.user.practiceId, (db) =>
    getProblemDetail(db, problemId),
  )
  if (!detail) notFound()

  return (
    <div>
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={session.user.roles.includes('PRACTICE_ADMIN')}
      />

      <main className="mx-auto max-w-2xl space-y-6 p-6 sm:p-8">
        <Link
          href={`/knihovna/${detail.id}`}
          className="inline-flex min-h-12 items-center text-text-tlumeny underline underline-offset-4 hover:text-hlavni"
        >
          Zpět na {detail.name}
        </Link>

        <h1 className="text-2xl font-semibold">Úprava problému</h1>

        <Card>
          <UpravitForm
            problemId={detail.id}
            name={detail.name}
            icd10={detail.icd10}
            note={detail.note}
            archived={detail.archivedAt !== null}
            documentCount={detail.documents.filter((d) => d.archivedAt === null).length}
          />
        </Card>
      </main>
    </div>
  )
}
