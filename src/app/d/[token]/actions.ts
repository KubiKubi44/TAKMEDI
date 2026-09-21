'use server'

import { revalidatePath } from 'next/cache'

import { PatientAccessError, verifyPatientAccess } from '@/lib/patient'
import { CrossOriginError, getRequestContext, requireTrustedOrigin } from '@/lib/request-context'

/**
 * Ověření pacienta u odkazu z e-mailu.
 *
 * Dvě pravidla, která tenhle soubor drží:
 *
 * 1. Token z formuláře se nikam nepíše. Nesmí se dostat do logu, do chybové
 *    hlášky ani do auditu – kdo by se k němu dostal, měl by rovnou přístup
 *    ke zdravotní dokumentaci. Jde jen do verifyPatientAccess() a do cesty
 *    pro revalidatePath().
 * 2. Odpověď se z formuláře skládá do jednoho tvaru TADY, ne v prohlížeči.
 *    Porovnává se totiž s otiskem uloženým u tokenu a obě strany musí
 *    počítat se stejnou podobou.
 */

const CHYBA_CIZI_PUVOD = 'Něco se pokazilo. Načtěte prosím stránku znovu a zkuste to ještě jednou.'
const CHYBA_BEZ_ODKAZU = 'Stránka se mezitím změnila. Otevřete prosím odkaz znovu.'

export type OvereniStav = { error?: string }

export async function verify(_prev: OvereniStav, formData: FormData): Promise<OvereniStav> {
  try {
    await requireTrustedOrigin()
  } catch (chyba) {
    if (chyba instanceof CrossOriginError) return { error: CHYBA_CIZI_PUVOD }
    throw chyba
  }

  const token = formData.get('token')
  if (typeof token !== 'string' || token === '') {
    return { error: CHYBA_BEZ_ODKAZU }
  }

  const odpoved = sestavOdpoved(formData)
  if ('chyba' in odpoved) return { error: odpoved.chyba }

  try {
    await verifyPatientAccess({
      token,
      answer: odpoved.hodnota,
      context: await getRequestContext(),
    })
  } catch (chyba) {
    // Hlášky z PatientAccessError jsou české a určené rovnou k zobrazení.
    // Cokoli jiného je chyba serveru a patří chybové hranici, ne pacientovi.
    if (chyba instanceof PatientAccessError) return { error: chyba.message }
    throw chyba
  }

  // Po ověření vykreslí Next stránku znovu už se seznamem dokumentů, a to
  // v odpovědi téhle akce – pacient nemusí nic načítat ani nikam klikat.
  revalidatePath(`/d/${token}`)
  return {}
}

/**
 * Z vyplněných polí udělá jeden řetězec k porovnání.
 *
 * Nerozhoduje se podle toho, co je vyplněné, ale podle toho, které pole
 * formulář vůbec má – jinak by prázdný formulář s číslicemi hlásil pacientovi,
 * že nevyplnil datum narození.
 *
 * DOHODA O TVARU DATA: rok-měsíc-den s nulami zleva, tedy „1948-03-05".
 * Až bude e-mailový kanál zakládat otisk data narození, musí počítat se
 * stejnou podobou – jinak správné datum neprojde a pacient vyčerpá pokusy,
 * aniž by udělal cokoli špatně.
 */
function sestavOdpoved(formData: FormData): { hodnota: string } | { chyba: string } {
  if (formData.has('pin')) {
    const pin = formData.get('pin')
    // Mezery a pomlčky, kterými si lidé číslice člení, nejsou chyba.
    const cislice = typeof pin === 'string' ? pin.replace(/\D/g, '') : ''

    if (cislice.length !== 6) {
      return { chyba: 'Číslo od lékaře má šest číslic. Zkontrolujte ho prosím.' }
    }
    return { hodnota: cislice }
  }

  const den = cislo(formData.get('den'))
  const mesic = cislo(formData.get('mesic'))
  const rok = cislo(formData.get('rok'))

  if (den === null || mesic === null || rok === null) {
    return { chyba: 'Vyplňte prosím den, měsíc i rok narození.' }
  }

  // Zkrácený rok („48") je nejčastější překlep a stojí za vlastní větu –
  // z obecného „nevypadá správně" by pacient nepoznal, co má opravit.
  const letos = new Date().getFullYear()
  if (rok < 1900 || rok > letos) {
    return { chyba: 'Rok narození nevypadá správně. Napište ho prosím celý, třeba 1948.' }
  }

  if (den < 1 || den > 31 || mesic < 1 || mesic > 12) {
    return { chyba: 'Datum narození nevypadá správně. Zkontrolujte prosím den a měsíc.' }
  }

  // Že 31. února neexistuje, se tu neřeší: takové datum se stejně žádnému
  // otisku nerovná, takže by kontrola navíc jen přidala další způsob, jak
  // formulář odmítnout.
  return { hodnota: `${rok}-${nuly(mesic)}-${nuly(den)}` }
}

function cislo(hodnota: FormDataEntryValue | null): number | null {
  if (typeof hodnota !== 'string') return null

  const text = hodnota.trim()
  if (!/^[0-9]{1,4}$/.test(text)) return null

  return Number(text)
}

function nuly(hodnota: number): string {
  return String(hodnota).padStart(2, '0')
}
