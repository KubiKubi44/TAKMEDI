import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { StorageNotFoundError, type FileStorage } from './types'

/**
 * Souborové úložiště pro vývoj.
 *
 * V produkci se používá S3-kompatibilní úložiště v EU; tenhle ovladač existuje
 * proto, aby se dalo vyvíjet a testovat bez běžící další služby.
 *
 * Obsah je zašifrovaný už na vstupu, takže i tady na disku leží nečitelný.
 */
export class FilesystemStorage implements FileStorage {
  constructor(private readonly root: string) {}

  /**
   * Cesta z úložiště se NIKDY nepoužije přímo jako cesta na disku.
   *
   * Kdyby v ní bylo '..', dal by se zápis i čtení vyvést mimo určený adresář.
   * Název souboru je proto otisk cesty a původní cesta se do něj nepromítá.
   */
  private resolve(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex')
    return path.join(this.root, digest.slice(0, 2), `${digest}.bin`)
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageNotFoundError(key)
      }
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    // force: true znamená, že chybějící soubor není chyba – úklidová úloha
    // musí jít spustit opakovaně.
    await rm(this.resolve(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key))
      return true
    } catch {
      return false
    }
  }
}
