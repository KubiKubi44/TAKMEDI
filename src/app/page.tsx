import type { Metadata } from 'next'

import { Hlavicka } from '@/components/hlavicka'
import { isPracticeAdmin, requireUser } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { listProblems } from '@/lib/library'
import { Priprava, type DokumentVolba, type ProblemVolba } from './priprava/priprava'

/**
 * Hlavní obrazovka: příprava balíčku pro pacienta.
 *
 * Nic jiného tu není záměrně. Lékař na ní stráví většinu času, který
 * s aplikací má, a každý další prvek by ho stál pozornost uprostřed ordinace.
 *
 * Kontrola přihlášení sedí tady, ne v layoutu: layout se při navigaci
 * nevykresluje znovu a nerozhoduje o tom, jestli se zbytek cesty spočítá.
 * Bezpečnostní hranicí je stránka.
 */

export const metadata: Metadata = {
  title: 'Příprava balíčku – MedPředání',
}

/**
 * Kolik problémů se pošle do prohlížeče.
 *
 * Hledání pak běží v prohlížeči nad hotovým seznamem, takže se výsledky mění
 * při psaní bez jediného požadavku po síti. Pro ordinaci s desítkami problémů
 * to stačí; větší knihovna si vyžádá hledání na serveru.
 */
const LIMIT_PROBLEMU = 50

export default async function HomePage() {
  const session = await requireUser()

  const vychoziProblemy = await withPractice(session.user.practiceId, async (db) => {
    const problemy = await listProblems(db, LIMIT_PROBLEMU)
    if (problemy.length === 0) return []

    /*
     * Dokumenty všech problémů jedním dotazem.
     *
     * getPreselectedDocuments() umí totéž pro jeden problém, ale zavolat ji
     * v cyklu by znamenalo padesát dotazů při každém otevření nejpoužívanější
     * obrazovky. Podmínka je stejná jako tam: živý dokument, který má
     * nahranou aktuální verzi.
     */
    const dokumenty = await db.templateDocument.findMany({
      where: {
        problemId: { in: problemy.map((problem) => problem.id) },
        archivedAt: null,
        currentVersionId: { not: null },
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        problemId: true,
        title: true,
        currentVersionId: true,
        currentVersion: { select: { pageCount: true } },
      },
    })

    const podleProblemu = new Map<string, DokumentVolba[]>()
    for (const dokument of dokumenty) {
      const seznam = podleProblemu.get(dokument.problemId) ?? []
      seznam.push({
        // Do balíčku jde VERZE, ne dokument – proto se posílá její identifikátor.
        versionId: dokument.currentVersionId!,
        title: dokument.title,
        pageCount: dokument.currentVersion?.pageCount ?? 0,
      })
      podleProblemu.set(dokument.problemId, seznam)
    }

    /*
     * Do prohlížeče jdou jen vypsaná prostá pole, ne záznamy z Prismy. Co se
     * dostane do RSC payloadu, to je v prohlížeči čitelné, i kdyby se nikde
     * nevykreslilo.
     */
    return problemy.map(
      (problem): ProblemVolba => ({
        id: problem.id,
        name: problem.name,
        icd10: problem.icd10,
        documents: podleProblemu.get(problem.id) ?? [],
      }),
    )
  })

  return (
    <div className="min-h-dvh">
      <Hlavicka
        userName={session.user.name}
        practiceName={session.practice.name}
        isAdmin={isPracticeAdmin(session.user)}
      />

      <main className="mx-auto w-full max-w-5xl px-6 py-8 sm:py-10">
        <Priprava vychoziProblemy={vychoziProblemy} />
      </main>
    </div>
  )
}
