import 'server-only'

import { hash, hashSync, parseOptions, verify } from '@node-rs/argon2'

/**
 * Hesla uživatelů.
 *
 * Na rozdíl od krátkých tajemství v crypto.ts (kód předání, PIN) má heslo
 * velký a neznámý prostor, takže se tu vyplatí pomalý hash. Argon2id je
 * současné doporučení OWASP a odolává jak útoku hrubou silou na GPU, tak
 * útokům přes postranní kanály.
 */

/**
 * Parametry podle doporučení OWASP pro argon2id (19 MiB paměti, 2 průchody,
 * paralelismus 1). Shodují se s výchozími hodnotami knihovny, ale píšou se
 * sem výslovně – kdyby knihovna výchozí hodnoty změnila, nesmí se to stát
 * potichu.
 */
const POLICY = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

/**
 * Návnada pro případ, že uživatel s daným e-mailem neexistuje.
 *
 * Bez ní by se přihlášení na neexistující e-mail vrátilo znatelně rychleji než
 * na existující a šlo by tak zjistit, kdo v aplikaci účet má. Návnada musí být
 * SKUTEČNÝ hash – verify() na prázdném nebo poškozeném řetězci vyhodí výjimku
 * ('Decoding failed'), nevrátí false.
 *
 * Počítá se jednou při načtení modulu, ne při každém požadavku.
 */
const DECOY_HASH = hashSync('navnada-ktera-se-nikdy-nepouzije', POLICY)

export async function hashPassword(password: string): Promise<string> {
  return hash(password, POLICY)
}

/**
 * Ověří heslo proti uloženému hashi.
 *
 * Když uživatel neexistuje, předej `null` – porovná se proti návnadě a doba
 * odpovědi zůstane stejná jako u existujícího účtu.
 *
 * Pozor na pořadí argumentů knihovny: verify(hash, heslo), ne naopak.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash ?? DECOY_HASH, password, POLICY)
  } catch {
    // Poškozený hash v databázi nesmí shodit přihlašovací obrazovku.
    return false
  }
}

/**
 * Pozná, že hash vznikl se slabšími parametry, než jaké platí dnes.
 * Volá se po úspěšném přihlášení – tehdy je heslo v ruce a dá se přehashovat.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const parsed = parseOptions(storedHash)
    return (
      parsed.memoryCost !== POLICY.memoryCost ||
      parsed.timeCost !== POLICY.timeCost ||
      parsed.parallelism !== POLICY.parallelism
    )
  } catch {
    return true
  }
}
