import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { env } from '../env'
import { StorageNotFoundError, type FileStorage } from './types'

/**
 * S3-kompatibilní úložiště v EU.
 *
 * Obsah je zašifrovaný aplikačním klíčem už na vstupu, takže poskytovatel
 * úložiště vidí jen neprůhledné bajty. Šifrování na jeho straně se tím
 * nenahrazuje, ale přestává být tím, na čem všechno stojí.
 */
export class S3Storage implements FileStorage {
  private readonly client: S3Client
  private readonly bucket: string

  constructor() {
    this.bucket = env.STORAGE_BUCKET!
    this.client = new S3Client({
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION!,
      // Vlastní endpointy (Scaleway, Hetzner, MinIO) potřebují cestu s názvem
      // koše místo poddomény.
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!,
      },
      // Výchozí timeouty SDK jsou NULOVÉ, tedy bez limitu. Nedostupné úložiště
      // by drželo obsluhu požadavku na desítky sekund a lékař by koukal na
      // zaseknutou obrazovku. throwOnRequestTimeout je nutné – bez něj se
      // překročení jen zaloguje a chyba se nevyhodí.
      requestHandler: {
        connectionTimeout: 3_000,
        requestTimeout: 15_000,
        throwOnRequestTimeout: true,
      },
    })
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Buffer, ne stream: PutObject se streamem a bez ContentLength spadne
        // na neplatnou hlavičku x-amz-decoded-content-length.
        Body: bytes,
        // Obsah je šifrovaný, takže typ nic neprozrazuje – a ani nemá.
        // Do Metadata se nesmí dávat názvy souborů: HTTP hlavičky neunesou
        // diakritiku a SDK je nekóduje, takže „Příbalový leták.pdf" shodí zápis.
        ContentType: 'application/octet-stream',
      }),
    )
  }

  async get(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      if (!response.Body) throw new StorageNotFoundError(key)
      return Buffer.from(await response.Body.transformToByteArray())
    } catch (error) {
      if (isNotFound(error)) throw new StorageNotFoundError(key)
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    // S3 hlásí úspěch i pro neexistující klíč, takže je mazání opakovatelné samo od sebe.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }
}

/**
 * Chybějící objekt hlásí S3 několika způsoby podle příkazu i podle
 * poskytovatele: GetObject vrací NoSuchKey, HeadObject jen holou 404 bez
 * názvu chyby. Proto se kontroluje obojí.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof StorageNotFoundError) return true
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
}
