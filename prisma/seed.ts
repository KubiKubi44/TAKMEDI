import 'dotenv/config'

import { randomUUID } from 'node:crypto'

import { hash } from '@node-rs/argon2'
import { PrismaPg } from '@prisma/adapter-pg'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'

import { PrismaClient } from '../src/generated/prisma/client'
import type { Role } from '../src/generated/prisma/enums'
import { decryptFile, encryptFile, hmacSecret, sha256Hex } from '../src/lib/crypto'
import { env } from '../src/lib/env'
import { FilesystemStorage } from '../src/lib/storage/filesystem'
import type { FileStorage } from '../src/lib/storage/types'

/**
 * Vývojová data pro MedPředání.
 *
 * Skript je psaný tak, aby šel spustit opakovaně: nic nemaže, všechno hledá
 * podle přirozeného klíče (slug ordinace, e-mail uživatele, název problému
 * a dokumentu) a podle výsledku buď zakládá, nebo aktualizuje.
 *
 * Ke každému dokumentu se vyrobí skutečné PDF a projde stejnou cestou jako
 * soubor nahraný lékařem: zašifruje se obálkovým šifrováním z src/lib/crypto.ts
 * a do úložiště jde až šifrovaný. Čitelné PDF na disku nikdy neleží.
 */

const SLUG_ORDINACE = 'ukazkova-ordinace'
const NAZEV_ORDINACE = 'Ordinace MUDr. Novákové'

/** Heslo je záměrně jedno pro všechny tři účty a vypisuje se na konci do konzole. */
const VYVOJOVE_HESLO = 'Ukazkove-heslo-1'

/**
 * Tajemství ukázkového NFC čipu. Pevné schválně: adresa k zápisu je pak
 * stejná při každém spuštění seedu a dá se opsat do NFC Tools jednou.
 * V provozu tajemství generuje aplikace náhodně a ukáže ho jen jednou.
 */
const VYVOJOVE_TAJEMSTVI_CIPU = 'ukazkovy-cip-jen-pro-vyvoj'
const NAZEV_CIPU = 'Ukázkový čip (seed)'

/** Patička na každé straně. Ať je na první pohled jasné, že jde o vývojová data. */
const PATICKA = 'Ukázková vývojová data aplikace MedPředání. Nejde o skutečné lékařské doporučení.'

/**
 * Parametry hashování se musí shodovat s src/lib/password.ts (doporučení OWASP
 * pro argon2id). Ten modul se sem ale importovat nedá: začíná importem
 * 'server-only', který mimo React Server Components vyhodí výjimku už při
 * načtení – a seed běží v čistém Node pod tsx. Proto se tu argon2 volá přímo
 * a shodu parametrů hlídá tenhle komentář.
 */
const ARGON2 = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

type ZadaniUzivatele = {
  email: string
  name: string
  roles: Role[]
}

const UZIVATELE: ZadaniUzivatele[] = [
  {
    email: 'lekar@example.cz',
    name: 'MUDr. Jana Nováková',
    roles: ['DOCTOR', 'PRACTICE_ADMIN'],
  },
  {
    email: 'sestra@example.cz',
    name: 'Petra Dvořáková',
    roles: ['NURSE'],
  },
  {
    email: 'admin@example.cz',
    name: 'Martin Svoboda',
    roles: ['PRACTICE_ADMIN'],
  },
]

type ZadaniDokumentu = {
  title: string
  /** Jedno pole na stranu, uvnitř odstavce. Počet stran = délka pole. */
  strany: string[][]
}

type ZadaniProblemu = {
  name: string
  icd10: string
  documents: ZadaniDokumentu[]
}

const KNIHOVNA: ZadaniProblemu[] = [
  {
    name: 'Po operaci kolene',
    icd10: 'Z96.6',
    documents: [
      {
        title: 'Poučení po operaci kolene',
        strany: [
          [
            'Prvních 14 dní mějte koleno v klidu a končetinu často polohujte výš než trup.',
            'Ránu udržujte suchou a čistou. Převaz dělá sestra, doma obvaz nerozbalujte.',
            'Chlaďte 10 minut několikrát denně. Led nikdy nepřikládejte přímo na kůži.',
          ],
          [
            'Berle používejte tak dlouho, dokud vám lékař nepovolí plnou zátěž.',
            'Kontrola je za 14 dní, termín dostanete u sestry na recepci.',
            'Ozvěte se ihned při horečce, prudké bolesti nebo prosakující ráně.',
          ],
        ],
      },
      {
        title: 'Režim prvních 14 dní',
        strany: [
          [
            'Den 1 až 3: klid na lůžku, koleno výš, chlazení, jen nezbytná chůze o berlích.',
            'Den 4 až 7: krátké procházky po bytě, koleno zkoušejte pomalu ohýbat.',
            'Den 8 až 14: delší chůze venku, stále o berlích, bez schodů a bez řízení.',
            'Sprchovat se smíte, až když je rána zhojená a lékař to potvrdí.',
          ],
        ],
      },
      {
        title: 'Cviky s obrázky',
        strany: [
          [
            'Cvik 1: leh na zádech, přitáhněte špičku k sobě a napněte stehno. Desetkrát.',
            'Cvik 2: vsedě propněte koleno do natažení a vydržte 5 sekund. Desetkrát.',
          ],
          [
            'Cvik 3: leh na zádech, podsuňte ručník pod koleno a tlačte do něj. Desetkrát.',
            'Cvik 4: vleže na boku zvedejte nataženou nohu do strany. Desetkrát.',
          ],
          [
            'Cviky dělejte dvakrát denně, vždy obě nohy a klidným tempem.',
            'Mírná bolest při cvičení je v pořádku. Prudká bolest znamená přestat.',
          ],
        ],
      },
      {
        title: 'Informovaný souhlas',
        strany: [
          [
            'Potvrzuji, že jsem byl nebo byla srozumitelně poučena o plánovaném výkonu.',
            'Byl mi vysvětlen účel výkonu, jeho průběh i očekávaný přínos pro mé zdraví.',
            'Byl jsem poučen o možných rizicích i o tom, jaké jsou jiné možnosti léčby.',
          ],
          [
            'Měl jsem možnost klást doplňující otázky a všem odpovědím jsem rozuměl.',
            'Souhlas mohu kdykoli odvolat, a to bez udání důvodu.',
            'Datum, podpis pacienta, podpis lékaře.',
          ],
        ],
      },
    ],
  },
  {
    name: 'Hypertenze – režimová opatření',
    icd10: 'I10',
    documents: [
      {
        title: 'Jak si správně měřit tlak doma',
        strany: [
          [
            'Před měřením 5 minut v klidu seďte, nekuřte a nepijte kávu.',
            'Manžetu dejte na holou paži do výše srdce, záda opřená, nohy na zemi.',
            'Během měření nemluvte a nehýbejte se.',
          ],
          [
            'Měřte ráno před léky a večer před spaním, vždy dvakrát po sobě.',
            'Zapište obě hodnoty i tep. Lékaře zajímá průměr za celý týden.',
            'Jedno vysoké měření nic neznamená. Rozhoduje dlouhodobý průměr.',
          ],
        ],
      },
      {
        title: 'Režimová opatření a jídelníček',
        strany: [
          [
            'Omezte sůl na 5 gramů denně, tedy zhruba na jednu čajovou lžičku.',
            'Nesolte na talíři a čtěte etikety u pečiva, uzenin a hotových jídel.',
            'Denně alespoň 400 gramů zeleniny a ovoce.',
          ],
          [
            'Hýbejte se 30 minut pět dní v týdnu, stačí svižná chůze.',
            'Alkohol nejvýše příležitostně, kouření je potřeba zcela vynechat.',
            'Každý kilogram dolů znamená zhruba o 1 mmHg nižší tlak.',
          ],
        ],
      },
      {
        title: 'Deník naměřených hodnot',
        strany: [
          [
            'Sloupce tabulky: datum a čas, horní tlak, dolní tlak, tep, poznámka.',
            'Vyplňujte ručně, stačí tužkou. Deník vezměte s sebou na kontrolu.',
            'Označte měření po námaze, po kávě nebo při bolesti hlavy.',
            'Cílem je doma naměřit méně než 135 na 85, pokud lékař neurčil jinak.',
          ],
        ],
      },
    ],
  },
  {
    name: 'Diabetes 2. typu – edukace',
    icd10: 'E11',
    documents: [
      {
        title: 'Co je diabetes 2. typu',
        strany: [
          [
            'Slinivka inzulin tvoří, ale tělo na něj přestává dostatečně reagovat.',
            'Cukr zůstává v krvi a dlouhodobě poškozuje cévy, oči, ledviny a nervy.',
            'Nemoc nebolí. Právě proto se hlídá měřením, a ne podle pocitu.',
          ],
          [
            'Hlavní léčbou je změna jídelníčku, pohyb a snížení hmotnosti.',
            'Léky a inzulin se přidávají tehdy, když tohle samo nestačí.',
            'Cílovou hodnotu glykovaného hemoglobinu určí lékař individuálně.',
          ],
        ],
      },
      {
        title: 'Jídelníček a sacharidové jednotky',
        strany: [
          [
            'Jedna sacharidová jednotka je 10 gramů sacharidů.',
            'Krajíc chleba, malé jablko nebo dvě lžíce rýže jsou zhruba jedna jednotka.',
          ],
          [
            'Rozdělte si jídlo do tří hlavních porcí, svačiny jen když máte hlad.',
            'Slazené nápoje vynechte úplně, včetně ovocných džusů.',
          ],
          [
            'Bílkovina a zelenina v každém jídle zpomalí vzestup cukru v krvi.',
            'Nejde o zákazy, ale o množství a o rozložení jídla během dne.',
          ],
        ],
      },
      {
        title: 'Měření glykémie doma',
        strany: [
          [
            'Ruce umyjte teplou vodou a osušte. Dezinfekce může výsledek zkreslit.',
            'Odběr z boční strany bříška prstu bolí méně než odběr ze středu.',
          ],
          [
            'Měřte nalačno a dvě hodiny po jídle, podle plánu od lékaře.',
            'Hodnoty zapisujte i s časem a s tím, co jste předtím jedli.',
          ],
        ],
      },
      {
        title: 'Péče o nohy',
        strany: [
          [
            'Nohy si každý den prohlédněte, i mezi prsty a na patách.',
            'Otlaky, praskliny a změnu barvy hlaste, i když vůbec nebolí.',
            'Boty kupujte odpoledne, kdy je noha největší, a nikdy nechoďte bosi.',
            'Nehty stříhejte rovně, mozoly si sami neodstraňujte.',
          ],
        ],
      },
    ],
  },
  {
    name: 'Akutní bolesti zad',
    icd10: 'M54.5',
    documents: [
      {
        title: 'Režim při akutní bolesti zad',
        strany: [
          [
            'Klid na lůžku nejvýše dva dny, delší ležení hojení zpomaluje.',
            'Hýbejte se v rozsahu, který nebolí. Pohyb je tady lék.',
            'Teplo uvolní svaly, chlad tlumí bolest. Vyzkoušejte, co vám sedí.',
            'Ozvěte se hned při slabosti nohy, mravenčení v rozkroku nebo potížích s močením.',
          ],
        ],
      },
      {
        title: 'Cviky na doma',
        strany: [
          [
            'Cvik 1: leh na zádech, pokrčená kolena, pomalu je přitahujte k hrudi.',
            'Cvik 2: vzpor klečmo, střídavě hrbte a prohýbejte záda.',
          ],
          [
            'Cvik 3: leh na břiše, opřete se o předloktí a chvíli vydržte.',
            'Cvičte dvakrát denně po deseti opakováních, nikdy přes bolest.',
          ],
        ],
      },
    ],
  },
]

/** České skloňování po číslovce: 1 problém, 2 problémy, 5 problémů. */
function sePoctem(pocet: number, tvary: [string, string, string]): string {
  if (pocet === 1) return `${pocet} ${tvary[0]}`
  if (pocet >= 2 && pocet <= 4) return `${pocet} ${tvary[1]}`
  return `${pocet} ${tvary[2]}`
}

if (process.env.NODE_ENV === 'production') {
  console.error('Seed se v produkci nespouští: zakládá účty se známým heslem.')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('Chybí DATABASE_URL v prostředí (viz .env.example).')
  process.exit(1)
}

/**
 * Seed se připojuje rolí VLASTNÍKA schématu (DATABASE_URL).
 *
 * Aplikační role medpredani_app nemá BYPASSRLS a její politika propustí jen
 * řádky té ordinace, jejíž id je v app.practice_id. Novou ordinaci by tedy
 * založit nemohla – v okamžiku zakládání žádné takové id ještě neexistuje,
 * takže by WITH CHECK politiky vyšla nepravdivě a INSERT by databáze odmítla.
 * Vlastník má pro migrace a seed vlastní politiku (owner_migrace) a vidí vše.
 * Běžící aplikace k téhle roli přístup nemá a mít nesmí.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

// ---------------------------------------------------------------------------
// Výroba PDF
// ---------------------------------------------------------------------------

const A4: [number, number] = [595.28, 841.89]
const OKRAJ = 56

/**
 * Vestavěné fonty pdf-lib kódují jen WinAnsi, takže by drawText na „č" spadl
 * ('WinAnsi cannot encode'). Vlastní písmo by znamenalo přibalit do repozitáře
 * několikasetkilobajtový TTF a závislost @pdf-lib/fontkit, kterou projekt nemá
 * a instalovat se nesmí. Pro vývojová data je to nepoměr: dokument má být
 * poznat podle nadpisu, a ten je bez háčků čitelný stejně dobře.
 *
 * Diakritika se tedy odstraní jen z VYKRESLOVANÉHO textu. Metadata dokumentu
 * ji unesou – pdf-lib je ukládá v UTF-16, ne ve WinAnsi.
 */
function bezDiakritiky(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** Zalomení na šířku sazby. Měří se skutečnou šířkou glyfů, ne počtem znaků. */
function zalom(text: string, font: PDFFont, velikost: number, sirka: number): string[] {
  const radky: string[] = []
  let radek = ''

  for (const slovo of text.split(' ')) {
    const kandidat = radek ? `${radek} ${slovo}` : slovo
    // Jediné slovo delší než řádek se nechá přetéct – lámat uvnitř slova by
    // u zdejších textů nikdy nenastalo.
    if (!radek || font.widthOfTextAtSize(kandidat, velikost) <= sirka) {
      radek = kandidat
    } else {
      radky.push(radek)
      radek = slovo
    }
  }

  if (radek) radky.push(radek)
  return radky
}

async function vyrobPdf(nadpis: string, podnadpis: string, strany: string[][]): Promise<Buffer> {
  const dokument = await PDFDocument.create()
  const bezne = await dokument.embedFont(StandardFonts.Helvetica)
  const tucne = await dokument.embedFont(StandardFonts.HelveticaBold)

  dokument.setTitle(nadpis)
  dokument.setSubject(podnadpis)
  dokument.setProducer('MedPředání – vývojová data')

  const sirka = A4[0] - 2 * OKRAJ

  strany.forEach((odstavce, index) => {
    const strana = dokument.addPage(A4)
    let y = A4[1] - OKRAJ - 18

    strana.drawText(bezDiakritiky(nadpis), {
      x: OKRAJ,
      y,
      size: 18,
      font: tucne,
      color: rgb(0.08, 0.09, 0.11),
    })
    y -= 20

    strana.drawText(bezDiakritiky(podnadpis), {
      x: OKRAJ,
      y,
      size: 10,
      font: bezne,
      color: rgb(0.42, 0.45, 0.5),
    })
    y -= 36

    for (const odstavec of odstavce) {
      for (const radek of zalom(bezDiakritiky(odstavec), bezne, 11, sirka)) {
        strana.drawText(radek, { x: OKRAJ, y, size: 11, font: bezne, color: rgb(0.13, 0.14, 0.16) })
        y -= 16
      }
      y -= 8
    }

    strana.drawText(`Strana ${index + 1} z ${strany.length}`, {
      x: OKRAJ,
      y: 64,
      size: 10,
      font: bezne,
      color: rgb(0.42, 0.45, 0.5),
    })
    strana.drawText(bezDiakritiky(PATICKA), {
      x: OKRAJ,
      y: 48,
      size: 8,
      font: bezne,
      color: rgb(0.55, 0.57, 0.6),
    })
  })

  return Buffer.from(await dokument.save())
}

// ---------------------------------------------------------------------------
// Úložiště
// ---------------------------------------------------------------------------

/**
 * Cesta v úložišti musí být znak po znaku shodná se storageKeys.templateVersion()
 * ze src/lib/storage/index.ts: vstupuje do šifrování jako doplňková
 * autentizovaná data, takže i jediný odlišný znak by se projevil až tím, že
 * aplikace soubor nedešifruje. Importovat ji odsud nejde – ten modul začíná
 * importem 'server-only' a mimo React Server Components vyhodí výjimku už při
 * načtení. Shodu proto na konci ověřuje zpětné přečtení jedné verze.
 */
function cestaVerze(practiceId: string, versionId: string): string {
  return `ordinace/${practiceId}/sablony/${versionId}.enc`
}

async function otevriUloziste(): Promise<FileStorage> {
  if (env.STORAGE_DRIVER === 's3') {
    // Načítá se až tady, aby se klient S3 nezaváděl na vývoji, kde se nepoužívá.
    const { S3Storage } = await import('../src/lib/storage/s3')
    return new S3Storage()
  }
  return new FilesystemStorage(env.STORAGE_LOCAL_DIR)
}

// ---------------------------------------------------------------------------
// Obsah dokumentů
// ---------------------------------------------------------------------------

type VysledekObsahu = {
  stav: 'nahrano' | 'obnoveno' | 'ponechano'
  versionId: string
}

/**
 * Zajistí, že dokument má aktuální verzi se skutečným zašifrovaným PDF.
 *
 * Tři možné situace, všechny musí být opakovaně spustitelné:
 *  - verze i obsah v úložišti jsou na místě → nedělá se nic,
 *  - verze je v databázi, ale obsah v úložišti chybí (typicky smazaný
 *    uploads-dev) → obsah se zapíše znovu pod TOUTÉŽ cestou, takže seed
 *    nepřidává verze navíc,
 *  - verze není → vyrobí se nová.
 */
async function zajistiObsah(params: {
  uloziste: FileStorage
  practiceId: string
  documentId: string
  currentVersionId: string | null
  uploadedById: string
  nadpis: string
  podnadpis: string
  strany: string[][]
}): Promise<VysledekObsahu> {
  const pdfBytes = await vyrobPdf(params.nadpis, params.podnadpis, params.strany)
  const pageCount = params.strany.length

  const spolecne = {
    sizeBytes: pdfBytes.byteLength,
    pageCount,
    sha256: sha256Hex(pdfBytes),
  }

  if (params.currentVersionId) {
    const stavajici = await prisma.templateDocumentVersion.findUnique({
      where: { id: params.currentVersionId },
      select: { id: true, storageKey: true },
    })

    if (stavajici) {
      if (await params.uloziste.exists(stavajici.storageKey)) {
        return { stav: 'ponechano', versionId: stavajici.id }
      }

      const zasifrovane = encryptFile(pdfBytes, stavajici.storageKey)
      await params.uloziste.put(stavajici.storageKey, zasifrovane.ciphertext)
      await prisma.templateDocumentVersion.update({
        where: { id: stavajici.id },
        data: {
          ...spolecne,
          dekWrapped: zasifrovane.dekWrapped,
          contentIv: zasifrovane.contentIv,
          contentTag: zasifrovane.contentTag,
          keyVersion: zasifrovane.keyVersion,
        },
      })
      return { stav: 'obnoveno', versionId: stavajici.id }
    }
  }

  // Id verze se určuje dopředu: je součástí cesty v úložišti a ta vstupuje
  // do šifrování, takže musí být známá dřív, než se obsah zašifruje.
  const versionId = randomUUID()
  const storageKey = cestaVerze(params.practiceId, versionId)
  const zasifrovane = encryptFile(pdfBytes, storageKey)

  await params.uloziste.put(storageKey, zasifrovane.ciphertext)

  const posledni = await prisma.templateDocumentVersion.findFirst({
    where: { templateDocumentId: params.documentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })

  await prisma.templateDocumentVersion.create({
    data: {
      id: versionId,
      practiceId: params.practiceId,
      templateDocumentId: params.documentId,
      version: (posledni?.version ?? 0) + 1,
      storageKey,
      ...spolecne,
      dekWrapped: zasifrovane.dekWrapped,
      contentIv: zasifrovane.contentIv,
      contentTag: zasifrovane.contentTag,
      keyVersion: zasifrovane.keyVersion,
      uploadedById: params.uploadedById,
    },
  })

  await prisma.templateDocument.update({
    where: { id: params.documentId },
    data: { currentVersionId: versionId },
  })

  return { stav: 'nahrano', versionId }
}

/**
 * Kontrola, že to, co leží v úložišti, jde zase přečíst.
 *
 * Ověřuje naráz tři věci, které se jinak projeví až v běžící aplikaci:
 * že v úložišti není čitelné PDF, že klíč u záznamu k obsahu sedí a že se
 * cesta v úložišti trefila do té, kterou používá aplikace.
 */
async function overCitelnost(uloziste: FileStorage, versionId: string): Promise<number> {
  const verze = await prisma.templateDocumentVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: {
      storageKey: true,
      dekWrapped: true,
      contentIv: true,
      contentTag: true,
      sha256: true,
      pageCount: true,
    },
  })

  const ciphertext = await uloziste.get(verze.storageKey)
  if (ciphertext.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw new Error(`V úložišti leží ČITELNÉ PDF pod ${verze.storageKey}. Šifrování neproběhlo.`)
  }

  const obsah = decryptFile({
    ciphertext,
    dekWrapped: verze.dekWrapped,
    contentIv: verze.contentIv,
    contentTag: verze.contentTag,
    storageKey: verze.storageKey,
  })

  if (obsah.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Dešifrovaný obsah nezačíná %PDF-.')
  }
  if (sha256Hex(obsah) !== verze.sha256) {
    throw new Error('Otisk dešifrovaného obsahu nesedí na sha256 v databázi.')
  }

  return verze.pageCount
}

// ---------------------------------------------------------------------------

async function seed() {
  const uloziste = await otevriUloziste()

  const practice = await prisma.practice.upsert({
    where: { slug: SLUG_ORDINACE },
    update: { name: NAZEV_ORDINACE },
    create: {
      slug: SLUG_ORDINACE,
      name: NAZEV_ORDINACE,
      addressLine: 'Dlouhá 12, 110 00 Praha 1',
    },
  })

  const passwordHash = await hash(VYVOJOVE_HESLO, ARGON2)

  /** Verze šablon se připisují lékaři – tak by vznikly i v běžném provozu. */
  let autorSablon: string | null = null

  for (const zadani of UZIVATELE) {
    const ulozeny = await prisma.user.upsert({
      where: { email: zadani.email },
      // Druhý faktor se ZÁMĚRNĚ nepřenastavuje. Nový účet ho nemá, takže si ho
      // uživatel projde při prvním přihlášení – a kdo si ho už jednou nastavil,
      // o něj opakovaným během seedu nepřijde.
      update: {
        practiceId: practice.id,
        name: zadani.name,
        roles: zadani.roles,
        status: 'ACTIVE',
        passwordHash,
        // Opakovaný seed zároveň odemkne účet, který se ve vývoji zamkl
        // několika překlepy v hesle.
        failedLoginCount: 0,
        lockedUntil: null,
      },
      create: {
        practiceId: practice.id,
        email: zadani.email,
        name: zadani.name,
        roles: zadani.roles,
        passwordHash,
      },
      select: { id: true },
    })

    if (zadani.roles.includes('DOCTOR')) autorSablon ??= ulozeny.id
  }

  if (!autorSablon) throw new Error('Mezi vývojovými účty není žádný lékař.')

  // Ukázkový čip. Opakovaný seed ho neduplikuje, jen obnoví tajemství
  // a případné odvolání – ať jde tok předání vždycky vyzkoušet.
  const cipHmac = hmacSecret(VYVOJOVE_TAJEMSTVI_CIPU)
  const existujiciCip = await prisma.nfcTag.findFirst({
    where: { practiceId: practice.id, label: NAZEV_CIPU },
    select: { id: true },
  })
  if (existujiciCip) {
    await prisma.nfcTag.update({
      where: { id: existujiciCip.id },
      data: { secretHmac: cipHmac, revokedAt: null },
    })
  } else {
    await prisma.nfcTag.create({
      data: {
        practiceId: practice.id,
        label: NAZEV_CIPU,
        secretHmac: cipHmac,
        createdById: autorSablon,
      },
    })
  }

  let pocetDokumentu = 0
  let pocetStran = 0
  const nove: VysledekObsahu['stav'][] = []
  let prvniVerze: string | null = null

  for (const [poradiProblemu, zadani] of KNIHOVNA.entries()) {
    // Problém nemá unikátní klíč na (practiceId, name), proto ruční dohledání
    // místo upsertu.
    const nalezeny = await prisma.problem.findFirst({
      where: { practiceId: practice.id, name: zadani.name },
      select: { id: true },
    })

    const problem = nalezeny
      ? await prisma.problem.update({
          where: { id: nalezeny.id },
          data: { icd10: zadani.icd10, sortOrder: poradiProblemu, archivedAt: null },
        })
      : await prisma.problem.create({
          data: {
            practiceId: practice.id,
            name: zadani.name,
            icd10: zadani.icd10,
            sortOrder: poradiProblemu,
          },
        })

    for (const [poradiDokumentu, dokument] of zadani.documents.entries()) {
      const nalezenyDokument = await prisma.templateDocument.findFirst({
        where: { practiceId: practice.id, problemId: problem.id, title: dokument.title },
        select: { id: true, currentVersionId: true },
      })

      const ulozeny = nalezenyDokument
        ? await prisma.templateDocument.update({
            where: { id: nalezenyDokument.id },
            data: { sortOrder: poradiDokumentu, archivedAt: null },
            select: { id: true, currentVersionId: true },
          })
        : await prisma.templateDocument.create({
            data: {
              practiceId: practice.id,
              problemId: problem.id,
              title: dokument.title,
              sortOrder: poradiDokumentu,
            },
            select: { id: true, currentVersionId: true },
          })

      const vysledek = await zajistiObsah({
        uloziste,
        practiceId: practice.id,
        documentId: ulozeny.id,
        currentVersionId: ulozeny.currentVersionId,
        uploadedById: autorSablon,
        nadpis: dokument.title,
        podnadpis: `${zadani.name} (MKN-10 ${zadani.icd10})`,
        strany: dokument.strany,
      })

      nove.push(vysledek.stav)
      prvniVerze ??= vysledek.versionId
      pocetDokumentu += 1
      pocetStran += dokument.strany.length
    }
  }

  if (!prvniVerze) throw new Error('Nevznikla žádná verze dokumentu.')
  const overenychStran = await overCitelnost(uloziste, prvniVerze)

  const adresaAplikace = process.env.APP_URL ?? 'http://localhost:3000'

  console.log('')
  console.log('Vývojová data jsou v databázi.')
  console.log('')
  console.log(`  Ordinace:  ${NAZEV_ORDINACE}`)
  console.log(`  Veřejná stránka: ${adresaAplikace}/o/${SLUG_ORDINACE}`)
  console.log(`  NFC čip:   ${adresaAplikace}/o/${SLUG_ORDINACE}/${VYVOJOVE_TAJEMSTVI_CIPU}`)
  console.log('             (tuhle adresu zapište na čip; ve vývoji stačí ji otevřít v telefonu)')
  const problemu = sePoctem(KNIHOVNA.length, ['problém', 'problémy', 'problémů'])
  const dokumentu = sePoctem(pocetDokumentu, ['dokument', 'dokumenty', 'dokumentů'])
  const stran = sePoctem(pocetStran, ['strana', 'strany', 'stran'])
  console.log(`  Knihovna:  ${problemu}, ${dokumentu}, dohromady ${stran}`)
  console.log(`             nově nahráno: ${nove.filter((v) => v === 'nahrano').length}`)
  console.log(`             obnoveno v úložišti: ${nove.filter((v) => v === 'obnoveno').length}`)
  console.log(`             beze změny: ${nove.filter((v) => v === 'ponechano').length}`)
  console.log('  Kontrola:  obsah v úložišti je zašifrovaný a po dešifrování začíná %PDF-')
  console.log(`             (ověřeno na jedné verzi, ${sePoctem(overenychStran, ['strana', 'strany', 'stran'])})`)
  console.log('')
  console.log(`  Přihlášení: ${adresaAplikace}/prihlaseni`)
  for (const zadani of UZIVATELE) {
    console.log(`    ${zadani.email.padEnd(20)} ${zadani.roles.join(', ')}`)
  }
  console.log('')
  console.log(`  Heslo pro všechny tři účty: ${VYVOJOVE_HESLO}`)
  console.log('')
  console.log('  Druhý faktor není nastavený. Aplikace vás při prvním přihlášení')
  console.log('  provede jeho zapnutím – je to zároveň ukázka celého toku.')
  console.log('')
  console.log('  Pozor: jde o vývojová data se známým heslem. Do produkce nepatří.')
  console.log('')
}

try {
  await seed()
} catch (error) {
  console.error('Seed selhal:', error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
