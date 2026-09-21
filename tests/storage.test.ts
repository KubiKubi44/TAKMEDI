import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'

import { decryptFile, encryptFile } from '@/lib/crypto'
import { FilesystemStorage } from '@/lib/storage/filesystem'
import { StorageNotFoundError } from '@/lib/storage/types'

const ROOT = './uploads-test'
const storage = new FilesystemStorage(ROOT)

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('souborové úložiště', () => {
  it('uloží a vrátí přesně ty samé bajty', async () => {
    const key = 'ordinace/a/sablony/1.enc'
    const data = randomBytes(1024)

    await storage.put(key, data)
    expect((await storage.get(key)).equals(data)).toBe(true)
  })

  it('neexistující cesta vyhodí StorageNotFoundError', async () => {
    await expect(storage.get('ordinace/a/neni.enc')).rejects.toThrow(StorageNotFoundError)
  })

  it('mazání jde spustit opakovaně', async () => {
    const key = 'ordinace/a/sablony/2.enc'
    await storage.put(key, randomBytes(64))

    await storage.delete(key)
    await expect(storage.delete(key)).resolves.toBeUndefined()
    expect(await storage.exists(key)).toBe(false)
  })

  it('cesta s ../ se nedostane mimo určený adresář', async () => {
    // Název souboru je otisk cesty, takže se původní cesta na disk nepromítá.
    // Kdyby se používala přímo, dal by se zápis vyvést kamkoli.
    const zakerna = 'ordinace/a/../../../../../../tmp/uniklo.enc'
    await storage.put(zakerna, Buffer.from('tajne'))

    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/uniklo.enc')).rejects.toThrow()

    // A přesto se to dá normálně přečíst zpátky.
    expect((await storage.get(zakerna)).toString()).toBe('tajne')
  })

  it('dvě ordinace se stejným názvem dokumentu se navzájem nepřepíšou', async () => {
    const a = 'ordinace/AAA/sablony/stejne.enc'
    const b = 'ordinace/BBB/sablony/stejne.enc'

    await storage.put(a, Buffer.from('ordinace A'))
    await storage.put(b, Buffer.from('ordinace B'))

    expect((await storage.get(a)).toString()).toBe('ordinace A')
    expect((await storage.get(b)).toString()).toBe('ordinace B')
  })
})

describe('šifrování při průchodu úložištěm', () => {
  it('na disku neleží čitelný obsah a po načtení se vrátí původní', async () => {
    const key = 'ordinace/a/zpravy/zprava.enc'
    const puvodni = Buffer.from('%PDF-1.7 Lékařská zpráva: pacient Jan Novák')

    const zasifrovane = encryptFile(puvodni, key)
    await storage.put(key, zasifrovane.ciphertext)

    const zUlozistе = await storage.get(key)
    expect(zUlozistе.includes('Jan Novák')).toBe(false)
    expect(zUlozistе.includes('%PDF')).toBe(false)

    const rozsifrovane = decryptFile({
      ciphertext: zUlozistе,
      dekWrapped: zasifrovane.dekWrapped,
      contentIv: zasifrovane.contentIv,
      contentTag: zasifrovane.contentTag,
      storageKey: key,
    })
    expect(rozsifrovane.equals(puvodni)).toBe(true)
  })
})
