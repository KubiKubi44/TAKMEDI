export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`V úložišti není nic pod cestou ${key}.`)
    this.name = 'StorageNotFoundError'
  }
}

export interface FileStorage {
  /** Uloží zašifrované bajty. Existující obsah pod stejnou cestou přepíše. */
  put(key: string, bytes: Buffer): Promise<void>

  /** Načte zašifrované bajty. Když nic takového není, vyhodí StorageNotFoundError. */
  get(key: string): Promise<Buffer>

  /** Smaže obsah. Neexistující cesta NENÍ chyba – mazání musí být opakovatelné. */
  delete(key: string): Promise<void>

  exists(key: string): Promise<boolean>
}
