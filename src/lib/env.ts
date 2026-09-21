import { z } from 'zod'

/**
 * Ověření konfigurace při startu.
 *
 * Aplikace radši spadne hned, než aby běžela s chybějícím šifrovacím klíčem
 * nebo s připojením do databáze pod nesprávnou rolí.
 */

const base64Key32 = z
  .string()
  .min(1, 'chybí hodnota')
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32
    } catch {
      return false
    }
  }, 'musí být 32 bajtů v base64 (vygeneruj: openssl rand -base64 32)')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Aplikační role. Nemá BYPASSRLS – každý dotaz pod ní podléhá oddělení
   * ordinací vynucenému v databázi.
   */
  APP_DATABASE_URL: z.string().min(1),
  /**
   * Rozlišovací role. Překládá session, slug ordinace a pacientský token na
   * ordinaci. Smí jen to, co jí dovolují granty v migraci.
   */
  RESOLVER_DATABASE_URL: z.string().min(1),

  /** Hlavní klíč pro obálkové šifrování souborů a citlivých polí. */
  FILE_MASTER_KEY: base64Key32,
  /** Pepper pro HMAC krátkých tajemství (kód předání, PIN, tajemství čipu). */
  SECRET_PEPPER: base64Key32,

  /**
   * Kde leží soubory. Ve vývoji stačí disk, v produkci se používá
   * S3-kompatibilní úložiště v EU.
   */
  STORAGE_DRIVER: z.enum(['filesystem', 's3']).optional(),
  /** Adresář pro souborový ovladač. Obsah je i tady zašifrovaný. */
  STORAGE_LOCAL_DIR: z.string().default('./uploads-dev'),

  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  /**
   * Kolik reverzních proxy stojí před aplikací.
   *
   * Next.js hlavičku x-forwarded-for jen DOPLNÍ, když chybí – nikdy k ní
   * nepřipojí skutečnou adresu klienta. Když si ji tedy klient pošle sám,
   * Next ji nechá být a pravá adresa je z požadavku nenávratně pryč.
   * Proto je potřeba vědět, kolik položek zprava je od vlastní infrastruktury.
   * Nula znamená, že se hlavičce nevěří vůbec.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  APP_URL: z.url(),

  /**
   * Tajemství pro spuštění úklidu z cronu. Bez něj se cesta /api/udrzba/uklid
   * tváří, že neexistuje.
   */
  CLEANUP_TOKEN: z.string().min(24).optional(),

  /**
   * Klíč pro šifrování uzávěrů Server Actions.
   *
   * Není to jen šifrování: stejná hodnota je solí pro hash identifikátorů akcí.
   * Bez pevné hodnoty dostane každý build jiná ID, takže po nasazení přestanou
   * fungovat i formuláře, které žádnou hodnotu neuzavírají – tedy i přihlášení.
   * Build v kontejneru navíc čtrnáctidenní cache klíče úplně vypíná.
   *
   * Musí být v prostředí UŽ PŘI BUILDU a končí v build artefaktu, takže se
   * nesmí použít FILE_MASTER_KEY ani SECRET_PEPPER – ty patří jen do běhu.
   */
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: base64Key32.optional(),

  EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  EMAIL_FROM: z.string().min(1),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
})

function load() {
  const parsed = schema.safeParse(process.env)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Chybná konfigurace prostředí:\n${problems}\n\n` +
        'Zkopíruj .env.example do .env a doplň hodnoty.',
    )
  }

  // Výchozí ovladač úložiště se odvozuje od prostředí: na vývoji disk,
  // v produkci S3. Napsat ho ručně jde vždycky.
  const driver =
    parsed.data.STORAGE_DRIVER ?? (parsed.data.NODE_ENV === 'production' ? 's3' : 'filesystem')

  if (driver === 's3') {
    const chybejici = (
      [
        'STORAGE_ENDPOINT',
        'STORAGE_REGION',
        'STORAGE_BUCKET',
        'STORAGE_ACCESS_KEY_ID',
        'STORAGE_SECRET_ACCESS_KEY',
      ] as const
    ).filter((klic) => !parsed.data[klic])

    if (chybejici.length > 0) {
      throw new Error(
        `Úložiště S3 vyžaduje ještě: ${chybejici.join(', ')}.\n` +
          'Pro vývoj bez S3 nastav STORAGE_DRIVER="filesystem".',
      )
    }
  }

  // DATABASE_URL (role vlastníka schématu) se schválně nečte. Běžící aplikace
  // k ní nesmí mít přístup – používá ji jen Prisma CLI při migracích a seedu.
  if (parsed.data.EMAIL_DRIVER === 'smtp' && !parsed.data.SMTP_HOST) {
    throw new Error('EMAIL_DRIVER=smtp vyžaduje vyplněný SMTP_HOST.')
  }

  // `next build` běží s NODE_ENV=production, ale build stroj není produkční
  // prostředí – veřejnou adresu ani počet proxy v tu chvíli znát nemusí
  // a často je ani znát nemá. Kontroly, které se týkají BĚHU, se proto při
  // buildu přeskakují; při prvním požadavku se stejně uplatní.
  const jeBuild = process.env.NEXT_PHASE === 'phase-production-build'

  if (parsed.data.NODE_ENV === 'production' && !jeBuild) {
    if (!parsed.data.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY) {
      throw new Error(
        'V produkci je NEXT_SERVER_ACTIONS_ENCRYPTION_KEY povinný. Bez něj se po každém\n' +
          'buildu změní identifikátory Server Actions a přihlašovací formulář přestane fungovat.',
      )
    }
    if (parsed.data.TRUSTED_PROXY_HOPS === 0) {
      console.warn(
        '[medpredani] TRUSTED_PROXY_HOPS=0: hlavičce x-forwarded-for se nevěří a IP adresy\n' +
          'v auditu budou prázdné. Za reverzní proxy nastav počet skoků.',
      )
    }
    if (parsed.data.EMAIL_DRIVER === 'console') {
      throw new Error(
        'V produkci musí být EMAIL_DRIVER="smtp". Ovladač console nic neodešle a zapíše\n' +
          'pacientský odkaz /d/<token> – tedy přístup k dokumentaci – do logu aplikace.',
      )
    }
    if (!parsed.data.APP_URL.startsWith('https://')) {
      throw new Error('V produkci musí APP_URL začínat https:// – session cookie se posílá jen přes HTTPS.')
    }
  }

  return { ...parsed.data, STORAGE_DRIVER: driver }
}

export const env = load()

export const isProduction = env.NODE_ENV === 'production'
