import type { Metadata } from 'next'
import Link from 'next/link'

import { Hlavicka } from '@/components/hlavicka'
import { Card } from '@/components/ui'
import { requireRole } from '@/lib/auth'
import { withPractice } from '@/lib/db'
import { NovyCip, OdvolatCip } from './cip-form'

/**
 * Správa NFC čipů ordinace.
 *
 * Oprávnění se ověřuje tady, ne v layoutu. Layout se při navigaci mezi
 * stránkami znovu nevykresluje a hlavně nerozhoduje o tom, jestli se zbytek
 * cesty spočítá – bezpečnostní hranicí je stránka a Server Action.
 *
 * Návod na téhle stránce není výplň. Čip zapisuje personál ordinace sám,
 * jednou, obvykle bez pomoci – a nezamčený nebo špatně nalepený čip je
 * bezpečnostní díra, kterou aplikace sama nijak nezacelí.
 */

export const metadata: Metadata = {
  title: 'NFC čip – MedPředání',
}

/**
 * Časová zóna se uvádí výslovně. Server běží v UTC a bez ní by se časy lišily
 * od toho, co má obsluha na hodinách.
 */
const FORMAT_DATA = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
})

export default async function CipPage() {
  const session = await requireRole('PRACTICE_ADMIN')
  const practiceId = session.user.practiceId

  // Sloupce jsou vypsané ručně, takže se do stránky nemůže dostat secretHmac.
  // Tajemství samo nikde neexistuje – v databázi je jen jeho HMAC a ani ten
  // nemá na cestě do prohlížeče co dělat.
  const cipy = await withPractice(practiceId, (db) =>
    db.nfcTag.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastSeenAt: true,
        revokedAt: true,
        createdBy: { select: { name: true } },
      },
    }),
  )

  const aktivni = cipy.filter((cip) => cip.revokedAt === null)
  const odvolane = cipy.filter((cip) => cip.revokedAt !== null)

  return (
    <div className="min-h-dvh">
      <Hlavicka userName={session.user.name} practiceName={session.practice.name} isAdmin />

      <main className="mx-auto w-full max-w-4xl space-y-10 px-6 py-8">
        <nav aria-label="Drobečková navigace">
          <Link
            href="/nastaveni"
            className="inline-flex min-h-12 items-center font-medium text-text-tlumeny hover:text-hlavni"
          >
            <span aria-hidden="true" className="mr-2">
              &larr;
            </span>
            Zpět na nastavení
          </Link>
        </nav>

        <header className="max-w-2xl">
          <p className="text-sm text-text-tlumeny">{session.practice.name}</p>
          <h1 className="text-2xl font-semibold">NFC čip</h1>
          <p className="mt-2 text-text-tlumeny">
            Čip je nálepka nalepená v ordinaci. Pacient k ní přiloží telefon, otevře se mu stránka
            vaší ordinace a opíše do ní čtyřmístný kód z vaší obrazovky. Tím dostane své dokumenty.
            Bez čipu předání přiložením telefonu nefunguje – tisk a e-mail ano.
          </p>
          <p className="mt-2 text-text-tlumeny">
            Čip nepatří konkrétnímu pacientovi ani balíčku. Jeden obslouží celou ordinaci; víc jich
            má smysl, když předáváte na víc místech – třeba v ordinaci a zvlášť na recepci.
          </p>
        </header>

        <section aria-labelledby="nadpis-cipy" className="space-y-4">
          <h2 id="nadpis-cipy" className="text-xl font-semibold">
            Čipy ordinace
          </h2>

          {aktivni.length === 0 ? (
            <Card className="max-w-2xl space-y-3">
              <h3 className="text-lg font-semibold">
                {odvolane.length > 0 ? 'Žádný platný čip tu není' : 'Zatím tu není žádný čip'}
              </h3>
              <p className="text-text-tlumeny">
                {odvolane.length > 0
                  ? 'Všechny čipy téhle ordinace jsou odvolané. Dokud nezapíšete nový, přiložení telefonu pacientovi nic neotevře.'
                  : 'Dokud čip nevytvoříte a nezapíšete na nálepku, zůstane tlačítko „Předat přes NFC“ bez užitku. Postup je popsaný níže; celé to zabere pár minut.'}
              </p>
            </Card>
          ) : (
            <>
              {/* Rámeček se kreslí ručně, ne přes Card – tabulka potřebuje
                  odsazení uvnitř buněk, ne kolem celé karty. */}
              <div className="overflow-x-auto rounded-2xl border border-obrys bg-plocha shadow-sm">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Platné čipy ordinace</caption>
                  <thead>
                    <tr className="border-b border-obrys text-text-tlumeny">
                      <th scope="col" className="px-5 py-3 font-medium">
                        Popis
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Vytvořen
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        Naposledy použit
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium">
                        <span className="sr-only">Akce</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {aktivni.map((cip) => (
                      <tr key={cip.id} className="border-b border-obrys last:border-b-0">
                        <th scope="row" className="px-5 py-4 text-left font-medium">
                          {cip.label}
                        </th>
                        <td className="px-5 py-4 text-text-tlumeny">
                          {FORMAT_DATA.format(cip.createdAt)}
                          <span className="block">{cip.createdBy.name}</span>
                        </td>
                        <td className="px-5 py-4 text-text-tlumeny">
                          {cip.lastSeenAt ? (
                            FORMAT_DATA.format(cip.lastSeenAt)
                          ) : (
                            <span className="text-varovani">Zatím nikdy</span>
                          )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <OdvolatCip tagId={cip.id} label={cip.label} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="max-w-2xl space-y-2 text-sm text-text-tlumeny">
                <p>
                  Sloupec „Naposledy použit“ ukazuje poslední předání, které přes tenhle čip
                  doopravdy proběhlo – ne každé přiložení telefonu. Čip, který je pár dní starý a
                  pořád nemá jediné použití, nejspíš není zapsaný správně; ověřte ho podle
                  posledního kroku návodu.
                </p>
                <p>
                  Adresa zapsaná na čipu se znovu zobrazit nedá. V databázi je z ní jen otisk, ze
                  kterého ji zpětně nesložíme. Čip, u kterého si nejste jistí, odvolejte a zapište
                  nový.
                </p>
              </div>
            </>
          )}

          {odvolane.length > 0 ? (
            <div className="border-t border-obrys pt-6">
              <h3 className="text-sm font-medium tracking-wide text-text-tlumeny uppercase">
                Odvolané
              </h3>
              <ul className="mt-3 space-y-3 opacity-70">
                {odvolane.map((cip) => (
                  <li key={cip.id}>
                    <p className="font-medium">{cip.label}</p>
                    <p className="mt-1 text-sm text-text-tlumeny">
                      {/* revokedAt je tu vždy vyplněné – seznam se podle něj filtruje. */}
                      odvoláno {cip.revokedAt ? FORMAT_DATA.format(cip.revokedAt) : ''} · vytvořeno{' '}
                      {FORMAT_DATA.format(cip.createdAt)} ·{' '}
                      {cip.lastSeenAt
                        ? `naposledy použito ${FORMAT_DATA.format(cip.lastSeenAt)}`
                        : 'nikdy nepoužito'}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-2xl text-sm text-text-tlumeny">
                Odvolané čipy zůstávají v seznamu kvůli dohledávání. Nefungují a oživit je nejde.
                Nálepku slupte, ať ji nikdo nezkouší používat.
              </p>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="nadpis-navod" className="space-y-4">
          <h2 id="nadpis-navod" className="text-xl font-semibold">
            Jak adresu zapsat na čip
          </h2>

          <ol className="max-w-2xl space-y-6">
            <li>
              <h3 className="font-semibold">1. Co koupit</h3>
              <p className="mt-1 text-text-tlumeny">
                Nálepku NFC s čipem <strong className="font-semibold text-text">NTAG213</strong>{' '}
                nebo <strong className="font-semibold text-text">NTAG215</strong>. Stačí ta
                nejlevnější – adresa je krátká a do paměti se vejde i tomu menšímu. Prodávají se po
                kusech i v balení po deseti, v e-shopech s elektronikou. Jediná výjimka: pokud
                budete lepit na kov, kupte nálepku výslovně určenou na kov, jinak ji telefon
                nepřečte.
              </p>
            </li>

            <li>
              <h3 className="font-semibold">2. Co stáhnout do telefonu</h3>
              <p className="mt-1 text-text-tlumeny">
                Aplikaci na zápis NFC. Osvědčená a zdarma je{' '}
                <strong className="font-semibold text-text">NFC Tools</strong> – existuje pro
                Android i pro iPhone. Telefon musí umět NFC; umí to všechny iPhony od modelu 7 a
                drtivá většina Androidů. Zapisuje se jednou, takže klidně půjčeným telefonem.
              </p>
            </li>

            <li>
              <h3 className="font-semibold">3. Jak adresu zapsat</h3>
              <p className="mt-1 text-text-tlumeny">
                Níže vytvořte čip a zkopírujte adresu, kterou aplikace zobrazí. Pak v NFC Tools
                zvolte <strong className="font-semibold text-text">Zapsat</strong> (Write), dál{' '}
                <strong className="font-semibold text-text">Přidat záznam</strong> (Add a record) a
                z nabídky typ <strong className="font-semibold text-text">URL/URI</strong>. Do pole
                vložte adresu, potvrďte a klepněte na Zapsat. Telefon vyzve k přiložení – položte
                ho zadní stranou na nálepku a chvíli podržte, dokud aplikace nepotvrdí, že zápis
                proběhl.
              </p>
            </li>

            <li>
              <h3 className="font-semibold">4. Čip zamknout – tenhle krok nevynechávejte</h3>
              <p className="mt-1 text-text-tlumeny">
                Nezamčený čip může přepsat kdokoli, kdo k němu na dvě vteřiny přiloží telefon.
                Nemusí umět nic technického, stačí mu stejná aplikace zdarma. Přepsaná nálepka pak
                vede, kam si přeje on: třeba na stránku, která vypadá jako ta vaše a po pacientovi
                chce rodné číslo, kód z obrazovky nebo přihlášení. Pacient nic nepozná – přiloží
                telefon a otevře se mu, co tam někdo napsal. Vám se přitom nikde nic nezobrazí,
                protože se to celé odehraje mimo aplikaci.
              </p>
              <p className="mt-2 text-text-tlumeny">
                V NFC Tools je zámek pod <strong className="font-semibold text-text">Další</strong>{' '}
                (Other), položka <strong className="font-semibold text-text">Zamknout čip</strong>{' '}
                (Lock tag). Zámek je{' '}
                <strong className="font-semibold text-text">trvalý a nevratný</strong> – čip už
                nikdy nepůjde přepsat. Proto zamykejte až potom, co si adresu ověříte podle kroku 6.
                Zamčená nálepka se v případě potřeby neopravuje, jen odvolá a nahradí novou; stojí
                pár korun.
              </p>
            </li>

            <li>
              <h3 className="font-semibold">5. Kam čip nalepit</h3>
              <p className="mt-1 text-text-tlumeny">
                Tam, kam pacient pohodlně dosáhne telefonem vsedě i vestoje a kam personál vidí:
                čelo stolu u židle pro pacienta, deska vedle monitoru, pult recepce. Telefon se
                musí dostat k nálepce na pár centimetrů, takže ne pod desku ani za monitor.
              </p>
              <p className="mt-2 text-text-tlumeny">
                Nelepte ji tam, kde s ní může být někdo o samotě a beze svědků: čekárna, chodba,
                dveře zvenčí. Nelepte přímo na kov ani přes jiný čip – ani jedno telefon nepřečte.
                Nálepku se vyplatí přelepit průhlednou samolepkou, aby se neodrolila a nešla
                nenápadně vyměnit.
              </p>
            </li>

            <li>
              <h3 className="font-semibold">6. Jak ověřit, že to funguje</h3>
              <p className="mt-1 text-text-tlumeny">
                Odemkněte telefon a přiložte ho zadní stranou k nálepce. Má se nabídnout otevření
                stránky s názvem{' '}
                <strong className="font-semibold text-text">{session.practice.name}</strong>. Pokud
                zrovna neběží žádné předání, stránka napíše, že tu na vás nic nečeká – tak to má
                být. Pole pro kód se objeví až ve chvíli, kdy předání u pacienta spustíte.
              </p>
              <p className="mt-2 text-text-tlumeny">
                Když se neděje nic, posuňte telefon: anténa NFC bývá u iPhonu nahoře u fotoaparátu,
                u Androidů spíš uprostřed zad. Když se otevře cokoli jiného než vaše ordinace, čip
                nepoužívejte – odvolejte ho a zapište znovu.
              </p>
            </li>
          </ol>
        </section>

        <section aria-labelledby="nadpis-novy" className="space-y-4">
          <h2 id="nadpis-novy" className="text-xl font-semibold">
            Nový čip
          </h2>
          <Card>
            <NovyCip />
          </Card>
        </section>
      </main>
    </div>
  )
}
