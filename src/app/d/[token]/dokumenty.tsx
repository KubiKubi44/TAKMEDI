/**
 * Dokumenty pacienta ke stažení.
 *
 * Zůstává serverovou komponentou. Nic tady nepotřebuje interakci – stahování
 * je obyčejný odkaz, který funguje i ve starém telefonu a dá se podržet pro
 * nabídku „Uložit". Do prohlížeče se tak z téhle části stránky nedostane ani
 * řádka kódu a datum se spočítá jednou na serveru.
 */

/**
 * Datum se formátuje tady a s pevnou zónou.
 *
 * Server běží v UTC, telefon v zóně pacienta. Bez pevné zóny by odkaz platný
 * krátce po půlnoci vyšel pokaždé o den jinak – a kdyby se tahle komponenta
 * někdy vykreslovala i v prohlížeči, rozešla by se serverová podoba s tou
 * klientskou a React by po hydrataci hlásil rozdíl.
 */
const FORMAT_DATA = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Prague',
})

/**
 * Odkaz, který vypadá jako tlačítko.
 *
 * Stažení je navigace, ne akce – musí to být poctivé <a>, aby šlo podržet
 * prstem, otevřít na nové kartě a uložit. Button z ui.tsx vykresluje
 * <button>, proto se třídy opisují.
 */
const TLACITKO_HLAVNI =
  'flex min-h-20 w-full items-center justify-center gap-3 rounded-2xl bg-hlavni px-6 py-4 text-center text-xl font-semibold text-white transition-colors hover:bg-hlavni-tmavy'

/** Plocha jednoho dokumentu: 4 rem, při zdejší velikosti písma přes 65 px – na prst. */
const TLACITKO_DOKUMENTU =
  'flex min-h-16 w-full items-center justify-between gap-4 bg-plocha px-5 py-4 text-left transition-colors hover:bg-podklad'

export type Dokument = {
  id: string
  nazev: string
  stran: number
}

export function Dokumenty({
  token,
  dokumenty,
  celkemStran,
  platiDo,
}: {
  token: string
  dokumenty: Dokument[]
  celkemStran: number
  platiDo: Date
}) {
  // Jediný dokument nemá co slučovat – tlačítko „Stáhnout vše" by stáhlo
  // tentýž soubor podruhé, jen pod jiným názvem.
  const maSmyslSlucovat = dokumenty.length > 1

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Vaše dokumenty</h1>

        {dokumenty.length === 0 ? (
          <p className="text-lg">
            U tohohle odkazu zatím žádné dokumenty nejsou. Ozvěte se prosím ordinaci.
          </p>
        ) : (
          <>
            <p className="text-lg">
              Můžete si je uložit do telefonu, poslat do počítače nebo vytisknout. Otevírají se
              jako PDF.
            </p>

            {maSmyslSlucovat ? (
              <div className="space-y-2">
                <a href={`/d/${token}/vse.pdf`} className={TLACITKO_HLAVNI}>
                  <IkonaStazeni />
                  Stáhnout vše jako jedno PDF
                </a>
                <p className="text-center text-sm text-text-tlumeny">
                  {pocetDokumentu(dokumenty.length)}
                  {celkemStran > 0 ? `, ${pocetStran(celkemStran)}` : ''} v jediném souboru.
                </p>
              </div>
            ) : null}
          </>
        )}
      </section>

      {dokumenty.length > 0 ? (
        <section aria-labelledby="nadpis-jednotlive" className="space-y-4">
          <h2 id="nadpis-jednotlive" className="text-xl font-semibold">
            {maSmyslSlucovat ? 'Nebo po jednom' : 'Ke stažení'}
          </h2>

          <ul className="divide-y divide-obrys overflow-hidden rounded-2xl border border-obrys shadow-sm">
            {dokumenty.map((dokument) => (
              <li key={dokument.id}>
                <a
                  href={`/d/${token}/soubor/${dokument.id}`}
                  className={TLACITKO_DOKUMENTU}
                  aria-label={`Stáhnout ${dokument.nazev}${popisStran(dokument.stran, ', ')} – PDF`}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{dokument.nazev}</span>
                    <span className="mt-0.5 block text-sm text-text-tlumeny">
                      PDF{popisStran(dokument.stran, ' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-hlavni">
                    <IkonaStazeni />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="nadpis-platnost" className="space-y-4">
        <h2 id="nadpis-platnost" className="text-xl font-semibold">
          Odkaz platí do {FORMAT_DATA.format(platiDo)}.
        </h2>

        <p className="text-lg">
          Potom se stránka sama uzavře a dokumenty se z ní smažou. Když si je stáhnete do
          telefonu nebo do počítače, zůstanou vám napořád.
        </p>

        <div className="rounded-2xl border border-obrys bg-plocha p-6 shadow-sm">
          <h3 className="text-lg font-semibold">Uložte si tuhle stránku</h3>
          <p className="mt-2">
            Ať ji nemusíte hledat, až se k dokumentům budete chtít vrátit. Telefon pro ni vyrobí
            ikonu na ploše, stejnou, jako mají ostatní aplikace.
          </p>
          <ul className="mt-4 space-y-3">
            <li>
              <span className="font-semibold">iPhone:</span> dole uprostřed klepněte na čtvereček
              se šipkou nahoru a v nabídce, která vyjede, sjeďte níž na{' '}
              <span className="font-semibold">Přidat na plochu</span>.
            </li>
            <li>
              <span className="font-semibold">Telefon s Androidem:</span> vpravo nahoře klepněte
              na tři tečky pod sebou a zvolte{' '}
              <span className="font-semibold">Přidat na plochu</span>.
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="nadpis-soukromi" className="border-t border-obrys pt-8">
        <h2 id="nadpis-soukromi" className="text-xl font-semibold">
          Odkaz je jenom váš
        </h2>
        <p className="mt-2 text-lg">
          Kdokoli, kdo ho dostane, uvidí stejné dokumenty jako vy – a ty patří k vašemu zdraví.
          Neposílejte ho proto dál a nezveřejňujte ho.
        </p>
      </section>
    </div>
  )
}

/** Šipka do přihrádky. Kreslená přímo v kódu – zvenčí se na tuhle stránku nic nenačítá. */
function IkonaStazeni() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="size-6 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

/**
 * Počet stran s oddělovačem, nebo nic.
 *
 * U naskenované zprávy se počet stran nemusí podařit spočítat a v databázi je
 * pak nula. „0 stran" u dokumentu, který zjevně nějaké má, vypadá jako porucha
 * – radši se neřekne nic.
 */
function popisStran(stran: number, oddelovac: string): string {
  return stran > 0 ? `${oddelovac}${pocetStran(stran)}` : ''
}

function pocetStran(stran: number): string {
  if (stran === 1) return '1 strana'
  if (stran >= 2 && stran <= 4) return `${stran} strany`
  return `${stran} stran`
}

function pocetDokumentu(pocet: number): string {
  if (pocet === 1) return '1 dokument'
  if (pocet >= 2 && pocet <= 4) return `${pocet} dokumenty`
  return `${pocet} dokumentů`
}
