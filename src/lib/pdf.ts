import 'server-only'

import { Worker } from 'node:worker_threads'

import { PDFDocument } from 'pdf-lib'

/**
 * Práce s PDF.
 *
 * Soubory sem chodí od lidí a jejich zařízení, takže se nedá spoléhat na to,
 * že co má příponu .pdf, je PDF. Platí tu tři věci, které se zjistily měřením,
 * ne čtením dokumentace:
 *
 * 1. Parser pdf-lib se dá zahltit. Soubor, který začíná '%PDF-' a dál obsahuje
 *    smetí, rozhodí obnovovací skener do kvadratické složitosti – 1 MB trvá přes
 *    deset sekund, 20 MB déle než deset minut. Protože je to práce v hlavní
 *    smyčce, zmrazil by jediný takový soubor celou aplikaci všem. Parsování
 *    proto běží v odděleném vlákně s tvrdým časovým limitem.
 *
 * 2. Typy chyb pdf-lib se nedají rozlišit. Balíček je zkompilovaný do ES5, takže
 *    `e instanceof EncryptedPDFError` je vždy false a e.name je vždy 'Error'.
 *    Rozlišuje se proto podle textu zprávy a šifrování se pozná z vlastnosti
 *    dokumentu, ne z výjimky.
 *
 * 3. Úspěšné načtení NEZNAMENÁ platné PDF. Soubor s jediným řádkem '%PDF-1.7'
 *    se načte bez chyby a teprve getPageCount() spadne na TypeError.
 */

/** Nad tuhle velikost se soubor nepřijme. Lékařská zpráva ani leták tolik nemají. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Tvrdý strop pro zpracování jednoho souboru. Po jeho vypršení se vlákno ukončí. */
const PARSE_TIMEOUT_MS = 15_000

export type PdfProblem =
  | 'prazdny'
  | 'prilis-velky'
  | 'neni-pdf'
  | 'chraneny-heslem'
  | 'poskozeny'
  | 'bez-stranek'
  | 'trva-prilis-dlouho'
  | 'nepodporovany-obrazek'

const ZPRAVY: Record<PdfProblem, string> = {
  prazdny: 'Soubor je prázdný.',
  'prilis-velky': `Soubor je větší než ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
  'neni-pdf': 'Tohle není PDF. Vyberte prosím soubor ve formátu PDF.',
  'chraneny-heslem':
    'PDF je chráněné heslem. Uložte ho prosím bez hesla a nahrajte znovu – jinak ho pacient neotevře.',
  poskozeny: 'Soubor je poškozený a nejde otevřít. Zkuste ho prosím uložit znovu.',
  'bez-stranek': 'PDF neobsahuje žádnou stránku.',
  'trva-prilis-dlouho':
    'Soubor se nepodařilo zpracovat. Bývá to poškozeným PDF – zkuste ho prosím uložit znovu, například vytisknutím do PDF.',
  'nepodporovany-obrazek':
    'Tenhle formát obrázku neumíme zpracovat. Vyfoťte prosím dokument znovu, nebo použijte JPEG či PNG.',
}

export class PdfError extends Error {
  constructor(readonly problem: PdfProblem) {
    super(ZPRAVY[problem])
    this.name = 'PdfError'
  }
}

export type PdfInfo = { pageCount: number }

// ---------------------------------------------------------------------------
// Oddělené vlákno
// ---------------------------------------------------------------------------

/**
 * Zdroj vlákna je tu jako řetězec schválně.
 *
 * Kdyby to byl samostatný soubor, musel by se po sestavení aplikace dát najít
 * na disku, což je u bundleru křehké. Takhle se nic nehledá. Vyžaduje to, aby
 * byla pdf-lib za běhu dosažitelná přes require – proto je uvedená
 * v serverExternalPackages v next.config.ts.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { PDFDocument, PDFName } = require('pdf-lib')

/**
 * Sloučení NENÍ sanitizace. copyPages zahodí dokumentový JavaScript, přílohy
 * a /OpenAction, ale akce na úrovni stránky přežijí beze změny. U souborů od
 * cizích lidí se proto odstraňují ručně.
 */
function sanitizePage(page) {
  const node = page.node
  node.delete(PDFName.of('AA'))

  const annots = node.lookupMaybe(PDFName.of('Annots'), require('pdf-lib').PDFArray)
  if (!annots) return

  for (let i = annots.size() - 1; i >= 0; i--) {
    const annot = annots.lookup(i)
    if (!annot || typeof annot.get !== 'function') continue
    const action = annot.lookupMaybe(PDFName.of('A'), require('pdf-lib').PDFDict)
    const subtype = action && action.get(PDFName.of('S'))
    if (subtype && String(subtype) === '/JavaScript') annots.remove(i)
    annot.delete && annot.delete(PDFName.of('AA'))
  }
}

async function loadStrict(bytes) {
  // ignoreEncryption se zapíná jen kvůli ROZPOZNÁNÍ. pdf-lib žádné dešifrování
  // neumí, takže chráněný soubor se pak musí odmítnout – jinak by z něj vznikl
  // tiše rozbitý dokument.
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  if (doc.isEncrypted) throw new Error('MEDPREDANI_ENCRYPTED')

  let pageCount
  try {
    pageCount = doc.getPageCount()
  } catch (e) {
    throw new Error('MEDPREDANI_DAMAGED')
  }
  if (pageCount === 0) throw new Error('MEDPREDANI_NO_PAGES')

  return { doc, pageCount }
}

async function inspect(bytes) {
  const { doc, pageCount } = await loadStrict(bytes)

  // Zkusí se přesně to, co proběhne později při skládání balíčku. Radši teď,
  // kdy u obrazovky sedí lékař a může soubor vyměnit.
  const probe = await PDFDocument.create()
  const pages = await probe.copyPages(doc, doc.getPageIndices())
  pages.forEach(function (p) { probe.addPage(p) })
  await probe.save()

  return { pageCount }
}

async function merge(parts) {
  const merged = await PDFDocument.create()

  for (const part of parts) {
    const { doc } = await loadStrict(part)
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    pages.forEach(function (p) { merged.addPage(p) })
  }

  if (merged.getPageCount() === 0) throw new Error('MEDPREDANI_NO_PAGES')
  merged.getPages().forEach(sanitizePage)

  const catalog = merged.catalog
  catalog.delete(PDFName.of('Names'))
  catalog.delete(PDFName.of('OpenAction'))
  catalog.delete(PDFName.of('AcroForm'))

  const bytes = await merged.save()
  return { bytes, pageCount: merged.getPageCount() }
}

;(async () => {
  try {
    const task = workerData.task
    const result = task === 'merge' ? await merge(workerData.parts) : await inspect(workerData.bytes)
    parentPort.postMessage({ ok: true, result })
  } catch (e) {
    parentPort.postMessage({ ok: false, message: String((e && e.message) || e) })
  }
})()
`

type WorkerResult = { pageCount: number; bytes?: Uint8Array }

type WorkerReply = { ok: true; result: WorkerResult } | { ok: false; message: string }

function runInWorker(workerData: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData })

    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new PdfError('trva-prilis-dlouho'))
    }, PARSE_TIMEOUT_MS)

    worker.on('message', (reply: WorkerReply) => {
      clearTimeout(timer)
      void worker.terminate()
      if (reply.ok) resolve(reply.result)
      else reject(problemFromMessage(reply.message))
    })

    worker.on('error', (error) => {
      clearTimeout(timer)
      reject(problemFromMessage(String(error?.message ?? error)))
    })
  })
}

/**
 * Typy chyb pdf-lib se rozlišit nedají – po kompilaci do ES5 je z každé
 * prostý Error se jménem 'Error'. Rozhoduje tedy text.
 */
function problemFromMessage(message: string): PdfError {
  if (message.includes('MEDPREDANI_ENCRYPTED')) return new PdfError('chraneny-heslem')
  if (message.includes('MEDPREDANI_NO_PAGES')) return new PdfError('bez-stranek')
  if (message.includes('MEDPREDANI_DAMAGED')) return new PdfError('poskozeny')
  if (message.includes('No PDF header found')) return new PdfError('neni-pdf')
  return new PdfError('poskozeny')
}

// ---------------------------------------------------------------------------
// Veřejné rozhraní
// ---------------------------------------------------------------------------

/** Ověří, že přijatý soubor je použitelné PDF, a zjistí počet stránek. */
export async function inspectPdf(bytes: Buffer): Promise<PdfInfo> {
  guardSize(bytes)
  const result = await runInWorker({ task: 'inspect', bytes: new Uint8Array(bytes) })
  return { pageCount: result.pageCount }
}

/**
 * Sloučí dokumenty do jednoho PDF ve stejném pořadí, v jakém přišly.
 *
 * Běží taky v odděleném vlákně: slučování je práce procesoru a u většího
 * balíčku by jinak na několik sekund zastavilo obsluhu všech ostatních.
 */
export async function mergePdfs(parts: Buffer[]): Promise<Buffer> {
  if (parts.length === 0) throw new PdfError('bez-stranek')
  parts.forEach(guardSize)

  const result = await runInWorker({
    task: 'merge',
    parts: parts.map((part) => new Uint8Array(part)),
  })

  if (!result.bytes) throw new PdfError('poskozeny')
  return Buffer.from(result.bytes)
}

function guardSize(bytes: Buffer): void {
  if (bytes.byteLength === 0) throw new PdfError('prazdny')
  if (bytes.byteLength > MAX_FILE_BYTES) throw new PdfError('prilis-velky')
}

/**
 * Udělá z fotky nebo skenu jednostránkové PDF.
 *
 * Běží v hlavní smyčce, protože jde o jediný obrázek a dekodéry JPEG i PNG
 * v pdf-lib jsou rychlé – zahltit se dá parser PDF, ne tyhle.
 *
 * Podporuje jen JPEG a PNG. Je to vědomé rozhodnutí: nativní knihovna na
 * převod dalších formátů by znamenala dekódovat cizí obrázky v nativním kódu,
 * což je opakovaný zdroj bezpečnostních chyb. Telefony při odesílání přes
 * formulář obvykle převedou i HEIC na JPEG samy.
 */
export async function imageToPdf(bytes: Buffer, mimeType: string): Promise<Buffer> {
  guardSize(bytes)

  const document = await PDFDocument.create()

  let image
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // Kopie na nulový posun je nutná: embedder JPEG v pdf-lib dělá
      // new DataView(imageData.buffer) a posun tím zahodí, takže nad platnou
      // fotkou z poolu Node hlásí „SOI not found in JPEG".
      image = await document.embedJpg(new Uint8Array(bytes))
    } else if (mimeType === 'image/png') {
      image = await document.embedPng(new Uint8Array(bytes))
    } else {
      throw new PdfError('nepodporovany-obrazek')
    }
  } catch (error) {
    if (error instanceof PdfError) throw error
    // embedPng nevyhazuje Error, ale holý řetězec. Bez String() by na něm
    // spadla i tahle obsluha.
    throw new PdfError('nepodporovany-obrazek')
  }

  // A4 na výšku; obrázek se vejde celý a zůstane mu poměr stran.
  const A4 = { width: 595.28, height: 841.89 }
  const margin = 28
  const scale = Math.min(
    (A4.width - 2 * margin) / image.width,
    (A4.height - 2 * margin) / image.height,
    1,
  )
  const width = image.width * scale
  const height = image.height * scale

  const page = document.addPage([A4.width, A4.height])
  page.drawImage(image, {
    x: (A4.width - width) / 2,
    y: (A4.height - height) / 2,
    width,
    height,
  })

  return Buffer.from(await document.save())
}

/** Rozpozná PDF podle obsahu, ne podle názvu ani deklarovaného typu. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-'
}
