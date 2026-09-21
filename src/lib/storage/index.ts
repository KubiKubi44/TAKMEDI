import 'server-only'

import { env } from '../env'
import { FilesystemStorage } from './filesystem'
import type { FileStorage } from './types'

export type { FileStorage } from './types'
export { StorageNotFoundError } from './types'

/**
 * Úložiště souborů.
 *
 * Do úložiště se nikdy nedostane čitelný obsah – šifrování dělá crypto.ts ještě
 * před uložením, takže tahle vrstva pracuje s neprůhlednými bajty a o tom, co
 * v nich je, nic neví. Poskytovatel úložiště tedy nevidí zdravotní dokumentaci
 * ani tehdy, kdyby selhalo jeho vlastní šifrování.
 *
 * Rozhraní schválně pracuje s celými bajty, ne se streamem. Soubory mají
 * nejvýš jednotky megabajtů a dešifrování AES-GCM musí ověřit autentizační
 * značku, která je až na konci – streamovat a ověřovat až potom by znamenalo,
 * že prohlížeč už kus poškozených dat dostal.
 */

let cached: FileStorage | null = null

/**
 * Vrátí ovladač úložiště.
 *
 * Je to asynchronní kvůli línému načtení klienta S3: v produkci se má načíst,
 * na vývoji ne. Synchronní require() by tu byl chyba – projekt běží jako ESM
 * modul, kde require vůbec neexistuje, a typová kontrola by to nezachytila.
 */
export async function storage(): Promise<FileStorage> {
  if (cached) return cached

  if (env.STORAGE_DRIVER === 's3') {
    const { S3Storage } = await import('./s3')
    cached = new S3Storage()
  } else {
    cached = new FilesystemStorage(env.STORAGE_LOCAL_DIR)
  }

  return cached
}

/** Cesty v úložišti. Vždy začínají ordinací, takže je na první pohled vidět, čí to je. */
export const storageKeys = {
  templateVersion(practiceId: string, versionId: string): string {
    return `ordinace/${practiceId}/sablony/${versionId}.enc`
  },
  upload(practiceId: string, uploadId: string): string {
    return `ordinace/${practiceId}/zpravy/${uploadId}.enc`
  },
}
