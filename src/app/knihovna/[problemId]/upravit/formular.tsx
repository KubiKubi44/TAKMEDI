'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Alert, Button, Field, Input } from '@/components/ui'
import { setProblemArchived, updateProblem, type ProblemState } from '../../actions'

const PRAZDNY_STAV: ProblemState = {}

export function UpravitForm({
  problemId,
  name,
  icd10,
  note,
  archived,
  documentCount,
}: {
  problemId: string
  name: string
  icd10: string | null
  note: string | null
  archived: boolean
  documentCount: number
}) {
  const [stav, akce] = useActionState(updateProblem, PRAZDNY_STAV)

  return (
    <div className="space-y-8">
      <form action={akce} className="space-y-4">
        <input type="hidden" name="problemId" value={problemId} />

        {stav.error ? <Alert tone="chyba">{stav.error}</Alert> : null}
        {stav.saved ? <Alert tone="uspech">Změny jsou uložené.</Alert> : null}

        <Field label="Název problému" errors={stav.fieldErrors?.nazev}>
          <Input name="nazev" defaultValue={name} required maxLength={200} />
        </Field>

        <Field
          label="Kód MKN-10"
          hint="Nepovinné. Například Z96.6 nebo I10 – pomůže při hledání."
          errors={stav.fieldErrors?.icd10}
        >
          <Input name="icd10" defaultValue={icd10 ?? ''} maxLength={16} />
        </Field>

        <Field label="Poznámka" hint="Nepovinné. Vidí ji jen ordinace, ne pacient." errors={stav.fieldErrors?.poznamka}>
          <Input name="poznamka" defaultValue={note ?? ''} maxLength={500} />
        </Field>

        <UlozitTlacitko />
      </form>

      <div className="border-t border-obrys pt-6">
        <h2 className="font-semibold">{archived ? 'Archivovaný problém' : 'Archivace'}</h2>
        <p className="mt-2 text-sm text-text-tlumeny">
          {archived
            ? 'Problém je archivovaný, takže se nenabízí při přípravě balíčku. Dokumenty ani historie se nikam neztratily.'
            : `Archivovaný problém se přestane nabízet při přípravě balíčku. ${
                documentCount > 0
                  ? `Jeho ${pocetDokumentu(documentCount)} zůstanou v knihovně a už předané balíčky se nezmění.`
                  : 'Dokumenty ani historie se nikam neztratí.'
              }`}
        </p>

        <ArchivacniForm problemId={problemId} archived={archived} />
      </div>
    </div>
  )
}

function pocetDokumentu(count: number): string {
  if (count === 1) return '1 dokument'
  if (count < 5) return `${count} dokumenty`
  return `${count} dokumentů`
}

/**
 * Archivace je vratná, ale mění, co se nabízí při přípravě balíčku, takže si
 * ji obsluha potvrdí. Vrácení z archivu nic nerozbije a jde na jedno klepnutí.
 */
function ArchivacniForm({ problemId, archived }: { problemId: string; archived: boolean }) {
  const [ptamSe, setPtamSe] = useState(false)

  if (!archived && !ptamSe) {
    return (
      <Button type="button" variant="vedlejsi" className="mt-4" onClick={() => setPtamSe(true)}>
        Archivovat problém
      </Button>
    )
  }

  return (
    <form action={setProblemArchived} className="mt-4 flex flex-wrap items-center gap-3">
      <input type="hidden" name="problemId" value={problemId} />
      <input type="hidden" name="archivovat" value={archived ? 'ne' : 'ano'} />

      {ptamSe ? (
        <span className="text-sm text-text-tlumeny">Opravdu archivovat?</span>
      ) : null}

      <ArchivacniTlacitko archived={archived} />

      {ptamSe ? (
        <Button type="button" variant="nenapadny" onClick={() => setPtamSe(false)}>
          Zpět
        </Button>
      ) : null}
    </form>
  )
}

/** Vlastní komponenta: useFormStatus čte stav formuláře, ve kterém je vnořený. */
function ArchivacniTlacitko({ archived }: { archived: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="vedlejsi" disabled={pending}>
      {pending
        ? archived
          ? 'Vracím z archivu…'
          : 'Archivuji…'
        : archived
          ? 'Vrátit z archivu'
          : 'Ano, archivovat'}
    </Button>
  )
}

function UlozitTlacitko() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Ukládám…' : 'Uložit změny'}
    </Button>
  )
}
