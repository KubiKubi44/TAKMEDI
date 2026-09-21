# MedPředání

Webová aplikace pro ambulantní ordinace: lékař připraví pacientovi balíček
dokumentů (lékařská zpráva + připravená PDF k jeho problému) a pacient si ho
stáhne do telefonu přiložením k NFC čipu v ordinaci. Alternativně jde balíček
vytisknout nebo poslat e-mailem s PINem, který lékař řekne ústně. Co se komu
předalo, zůstává v historii a v auditním deníku; po vypršení platnosti se obsah
maže a zůstávají jen metadata.

Architektura a datový model jsou popsané v [docs/architektura.md](docs/architektura.md),
nasazení do produkce v [docs/nasazeni.md](docs/nasazeni.md).

## Požadavky

- Node.js 22 nebo novější
- PostgreSQL 16 (lokálně, nebo přes přiložený `docker-compose.yml`)
- Pro vývoj **nic dalšího**: soubory se ukládají zašifrované na disk do
  `uploads-dev/` a e-maily se vypisují do konzole. S3-kompatibilní úložiště
  a SMTP jsou potřeba až v produkci (v `docker-compose.yml` je na zkoušku MinIO).

## Rozběhnutí

```bash
npm install

# 1) Role a databáze. Spouští se jednou, jako superuživatel.
psql -d postgres -f scripts/priprav-db.sql

# 2) Konfigurace. Vygeneruj si vlastní klíče.
cp .env.example .env
openssl rand -base64 32   # → FILE_MASTER_KEY
openssl rand -base64 32   # → SECRET_PEPPER

# 3) Schéma
npx prisma migrate deploy
npx prisma generate

# 4) Vývojová data: ordinace, tři účty, čtyři problémy a k nim skutečná PDF
npm run db:seed

# 5) Vývojový server
npm run dev
```

Používáš-li `docker-compose.yml` vedle lokálního PostgreSQL, běží kontejner na
portu **5433** – uprav podle toho adresy v `.env`.

### Příkazy

| Příkaz | Co dělá |
|---|---|
| `npm run dev` | vývojový server |
| `npm run build` | produkční build (spustí `prisma generate` a pak `next build`) |
| `npm run start` | spustí hotový produkční build |
| `npm run typecheck` | typová kontrola |
| `npm test` | přehraje migrace do testovací databáze a spustí testy |
| `npm run test:watch` | testy průběžně, bez přípravy databáze |
| `npm run db:up` | PostgreSQL z `docker-compose.yml` (port 5433) |
| `npm run db:migrate` | nová migrace z aktuálního schématu |
| `npm run db:deploy` | přehraje hotové migrace, nic negeneruje |
| `npm run db:reset` | zahodí databázi, přehraje migrace a spustí seed |
| `npm run db:studio` | prohlížeč dat |
| `npm run db:seed` | ukázková data (ordinace, problémy, PDF) |
| `npm run dev:2fa -- <e-mail>` | vypíše aktuální kód druhého faktoru (jen pro vývoj) |
| `npm run dev:2fa -- <e-mail> --reset` | zruší druhý faktor, ať se dá jeho nastavení projít znovu |

V `package.json` jsou ještě dva skripty, které **zatím nefungují**: `lint` volá
`next lint`, a ten Next.js 16 už nemá, a `uklid` míří na `scripts/uklid.ts`, který
v repozitáři není. Úklid po expiraci se spouští cestou `/api/udrzba/uklid` –
viz [docs/nasazeni.md](docs/nasazeni.md).

### Přihlášení do vývojových dat

Po `npm run db:seed` vzniknou tři účty se stejným heslem `Ukazkove-heslo-1`:

| E-mail | Role |
|---|---|
| `lekar@example.cz` | Lékař + Admin ordinace |
| `sestra@example.cz` | Sestra |
| `admin@example.cz` | Admin ordinace |

Dvoufázové přihlášení je povinné, takže tě aplikace po zadání hesla provede jeho nastavením.
Nemáš-li po ruce telefon s ověřovací aplikací, nech si stránku s QR kódem zobrazit (tím
tajemství vznikne) a kód si nech vypsat příkazem `npm run dev:2fa -- lekar@example.cz`.

## Obrazovky

Adresy jsou česky schválně – pacient i lékař je vidí. Ordinace se u každé bere ze
session, nikdy z adresy.

### Za přihlášením (heslo + druhý faktor)

| Cesta | Co tam je | Kdo |
|---|---|---|
| `/` | Příprava balíčku: hledání problému, zaškrtnutí dokumentů, přiložení lékařské zprávy, označení pacienta a tři tlačítka předání | všichni |
| `/predani/[activationId]` | Kód předání a odpočet; stránka se sama ptá serveru, jestli si už pacient balíček vyzvedl | všichni |
| `/historie` | Předané balíčky od nejnovějšího, filtr podle data, problému a uživatele, tlačítko „Zneplatnit odkaz“ | všichni |
| `/historie/[packageId]` | Detail jednoho předání a jeho časová osa z auditního deníku včetně IP adres | lékař, admin |
| `/knihovna` | Problémy ordinace, hledání podle názvu i kódu MKN-10 | všichni (sestra jen čte) |
| `/knihovna/[problemId]` | Dokumenty problému a jejich verze, náhledy; lékař a admin navíc nahrávají, přejmenovávají, řadí a archivují | všichni (sestra jen čte) |
| `/knihovna/novy` · `/knihovna/[problemId]/upravit` | Založení problému, úprava názvu a kódu, archivace | lékař, admin |
| `/nastaveni` | Uživatelé, role, stav účtu a druhého faktoru, obnova přístupu (nové jednorázové heslo, zrušení druhého faktoru); nastavení ordinace (platnost odkazu, délka okna předání, odhlášení při nečinnosti) | admin |
| `/nastaveni/cip` | Čipy ordinace a návod, jak nálepku zapsat, ověřit a zamknout | admin |
| `/nastaveni/audit` | Auditní deník ordinace se stránkováním a s ověřením neporušenosti hashového řetězu | lékař, admin |
| `/prihlaseni` · `/prihlaseni/nastaveni-2fa` · `/prihlaseni/overeni` | Heslo, zapnutí druhého faktoru, kód z ověřovací aplikace | — |

### Veřejné, pro pacienta

| Cesta | Co tam je |
|---|---|
| `/o/[slug]` | Neutrální stránka ordinace. **Není tu pole na kód** – to je bezpečnostní opatření, ne opomenutí (viz níže). |
| `/o/[slug]/[tagSecret]` | Otevře se po přiložení telefonu k čipu. Jediné místo v aplikaci, kde jde kód předání zadat. |
| `/d/[token]` | Dokumenty pacienta. U odkazu poslaného e-mailem se stránka nejdřív zeptá na PIN a do té doby neprozradí ani název ordinace. |
| `/d/[token]/soubor/[dokumentId]` · `/d/[token]/vse.pdf` | Jeden dokument, nebo všechny sloučené do jednoho PDF. |

### Rozhraní

Soubory a JSON chodí přes route handlery, ne přes Server Actions – ty mají strop těla
1 MB a jeho překročení se vyhodí dřív, než se dá odchytit.

| Cesta | Metoda | K čemu |
|---|---|---|
| `/api/balicky` | POST, PUT | Založení rozpracovaného balíčku a uložení výběru dokumentů |
| `/api/balicky/[packageId]/zprava` | POST | Nahrání lékařské zprávy (PDF, JPEG nebo PNG, do 20 MB; obrázek server převede na stránku PDF) |
| `/api/balicky/[packageId]/tisk.pdf` | GET | Sloučené PDF k tisku |
| `/api/balicky/[packageId]/email` | POST | Odeslání odkazu e-mailem; v odpovědi je PIN |
| `/api/predani/aktivovat` · `/api/predani/[activationId]/zrusit` | POST | Spuštění a zrušení předání přes čip |
| `/api/predani/[activationId]/stav` | GET | Stav předání pro odpočet na obrazovce lékaře |
| `/api/knihovna/nahrat` | POST | Nová verze dokumentu v knihovně |
| `/api/knihovna/verze/[versionId]` | GET | Stažení verze dokumentu |
| `/api/udrzba/uklid` | POST | Úklid po expiraci, spouští cron s hlavičkou `X-Uklid-Token` |

## Jak probíhá předání přes NFC

Hlavní funkce aplikace, krok za krokem.

**Jednou na začátku.** Admin ordinace na `/nastaveni/cip` založí čip. Aplikace mu ukáže
adresu tvaru `https://<doména>/o/<ordinace>/<tajemství>` – **jedinkrát**, protože
v databázi z ní zůstane jen otisk. Tu adresu zapíše běžnou aplikací na NFC (třeba NFC
Tools) na nálepku, ověří přiložením telefonu a nálepku **zamkne**. Nálepka se pak nalepí
tam, kam pacient pohodlně dosáhne a kam personál vidí – ne do čekárny.

**Při každém pacientovi:**

1. Lékař na hlavní obrazovce napíše pár písmen z názvu problému a klikne na výsledek.
   Dokumenty k problému se zaškrtnou samy, nechtěné odškrtne. Lékařskou zprávu přetáhne
   nebo vyfotí; převod na stránku PDF udělá server.
2. Klik na **Předat přes NFC**. Server uloží balíček, zruší případné předchozí běžící
   předání téhle ordinace a vylosuje čtyřmístný kód. Do databáze jde jen jeho HMAC
   s pepperem – čitelný je kód jedinkrát, v odpovědi na tenhle požadavek.
3. Lékaři se objeví kód a odpočet, ve výchozím nastavení 180 sekund. Obrazovka se každé
   dvě sekundy ptá serveru, jestli si už pacient balíček vyzvedl.
4. Pacient přiloží telefon k nálepce. Telefon nabídne otevření stránky ordinace a na ní
   je pole na čtyři číslice. Objeví se jen tehdy, když nějaké předání opravdu běží;
   jinak stránka napíše, že tu na pacienta nic nečeká.
5. Pacient opíše čtyři číslice z obrazovky lékaře. Server je ověřuje v transakci se
   zamčením řádku, takže souběžné pokusy nemohou počítadlo obejít. Pět špatných pokusů
   **dohromady** (ne na IP adresu) předání zamkne a lékař ho musí spustit znovu.
6. Při správném kódu vznikne pacientský odkaz `/d/<token>` (32 náhodných bajtů, v databázi
   jen jeho SHA-256), telefon na něj hned skočí a lékaři se objeví „Předáno“.
7. Odkaz platí 30 dní (nastavitelné u ordinace). Pacient si dokumenty otevře po jednom
   nebo stáhne jako jedno PDF; každé stažení je řádek v auditním deníku. Odkaz jde
   kdykoli zneplatnit z `/historie`. Po vypršení noční úklid smaže obsah souborů i jméno
   pacienta – v historii zůstane, že se něco předalo, ale ne komu a co.

**Proč stačí čtyři číslice.** Adresa na čipu obsahuje tajemství, které se nikde jinde
neobjeví. Bez něj `/o/<ordinace>` ukáže jen název ordinace a žádné pole na kód, takže
kód nemá kde hádat nikdo, kdo nestál telefonem u nálepky. K tomu je počítadlo pokusů
na celé předání, ne na IP adresu: šance na uhodnutí je nejvýš 5 z 10 000 bez ohledu na
to, kolik útočníků to zkouší.

## Konfigurace

Všechny hodnoty se ověřují při startu v [src/lib/env.ts](src/lib/env.ts) –
aplikace radši spadne hned, než aby běžela bez šifrovacího klíče.

| Proměnná | Význam |
|---|---|
| `DATABASE_URL` | role vlastníka schématu. **Jen pro migrace a seed.** V produkci se běžící aplikaci nepředává. |
| `APP_DATABASE_URL` | aplikační role. Nemá `BYPASSRLS`, podléhá oddělení ordinací vynucenému databází. |
| `RESOLVER_DATABASE_URL` | rozlišovací role. Překládá session, slug ordinace a pacientský token na ordinaci. |
| `FILE_MASTER_KEY` | 32 bajtů v base64. Obálkové šifrování souborů a citlivých polí. |
| `SECRET_PEPPER` | 32 bajtů v base64. HMAC krátkých tajemství (kód předání, PIN, tajemství čipu). |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | 32 bajtů v base64. **Musí být nastavený už při buildu** a končí v build artefaktu, takže to nesmí být stejná hodnota jako dva klíče výše. |
| `TRUSTED_PROXY_HOPS` | Kolik reverzních proxy stojí před aplikací. 0 = hlavičce `x-forwarded-for` se nevěří. |
| `APP_URL` | Veřejná adresa. Vstupuje do odkazů na čipu i v e-mailech a do kontroly původu požadavku. V produkci musí být `https://`. |
| `CLEANUP_TOKEN` | Tajemství pro cron úklidu. Bez něj se `/api/udrzba/uklid` tváří, že neexistuje. |

Zbytek (úložiště, SMTP, testovací databáze) je vypsaný i s vysvětlením
v [.env.example](.env.example) a v [docs/nasazeni.md](docs/nasazeni.md).

**Ztráta `FILE_MASTER_KEY` znamená ztrátu všech souborů a jmen pacientů.**
Patří do správce tajemství, ne do repozitáře, a musí se zálohovat odděleně od
databáze. Ztráta `SECRET_PEPPER` zneplatní běžící aktivace předání a PINy –
méně bolestivé, ale taky se zálohuje.

## Jak drží oddělení ordinací

Izolace mezi ordinacemi se neopírá o pozornost při psaní dotazů. Stojí na třech
vrstvách a nejdůležitější je ta poslední:

1. `practiceId` se bere výhradně ze serverové session, nikdy z URL ani z těla
   požadavku.
2. Veškerý provoz jde přes `withPractice()` v [src/lib/db.ts](src/lib/db.ts),
   které otevře transakci a nastaví v ní kontext ordinace.
3. PostgreSQL row-level security tenhle kontext vynucuje. Politiky porovnávají
   `practice_id = app_practice_id()`. Když kontext chybí, funkce vrátí `NULL`,
   porovnání vyjde `NULL` a **nevrátí se žádný řádek** – chyba v aplikaci tedy
   vede k prázdnému výsledku, ne k úniku dat.

Ověřeno testy v [tests/tenant-isolation.test.ts](tests/tenant-isolation.test.ts),
které schválně **nepoužívají** filtr podle ordinace – kdyby izolaci držel jen
aplikační kód, padly by.

## Nasazení: tři věci, které se snadno udělají špatně

Celý postup od prázdného serveru je v [docs/nasazeni.md](docs/nasazeni.md) – role
v databázi, proměnné prostředí, konfigurace proxy, cron, zálohy, kontrolní seznam
a co dělat při podezření na únik. Tohle jsou tři místa, na kterých to nejčastěji
skončí špatně:

**Reverzní proxy musí přepisovat `x-forwarded-for`, ne k ní přidávat.** Next.js hlavičku
jen doplní, když chybí – když si ji klient pošle sám, Next ji nechá být a skutečnou
adresu nikam nepřipojí. Často doporučované nginx `proxy_add_x_forwarded_for` klientovu
hodnotu zachová, a je tedy pro tenhle účel nevhodné; správně je `proxy_set_header
X-Forwarded-For $remote_addr`, u Caddy `header_up X-Forwarded-For {remote_host}`.
Bez toho jsou IP adresy v auditu i omezování četnosti podle IP pod kontrolou útočníka.
Počet vlastních proxy se nastavuje v `TRUSTED_PROXY_HOPS`.

**`x-forwarded-host` musí proxy taky přepisovat.** Next jí dává přednost před `host`
a nijak ji neověřuje.

**`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` předej už do buildu**, ne jen do běhu:

```bash
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<klíč> npm run build
```

Ta hodnota je zároveň solí pro hash identifikátorů Server Actions. Bez ní dostane každý
build jiná ID a po nasazení přestanou fungovat i formuláře, které žádnou hodnotu
neuzavírají – tedy i přihlášení. Build v kontejneru navíc čtrnáctidenní cache klíče
úplně vypíná.

## Zpracování nahraných souborů

Soubory do knihovny nahrávají lidé, takže se nedá spoléhat na to, že co má příponu `.pdf`,
je PDF. Tři věci se tu dělají jinak, než by se čekalo, a všechny tři vyplynuly z měření:

**Parsování PDF běží v odděleném vlákně s tvrdým limitem.** Soubor, který začíná `%PDF-`
a dál obsahuje smetí, rozhodí obnovovací skener pdf-libu do kvadratické složitosti –
1 MB trvá přes deset sekund, 20 MB déle než deset minut. Protože je to práce v hlavní
smyčce, zmrazil by jediný takový soubor aplikaci **všem** uživatelům. Test
`smetí za hlavičkou PDF neblokuje hlavní smyčku` to hlídá tím, že měří odezvu, ne dobu
zpracování.

**Typy chyb pdf-libu se nedají rozlišit.** Knihovna je zkompilovaná do ES5, takže
`e instanceof EncryptedPDFError` je vždy `false` a `e.name` je vždy `'Error'`.
Rozlišuje se proto podle textu zprávy, a šifrování se pozná z vlastnosti dokumentu
(`doc.isEncrypted`), ne z výjimky.

**Úspěšné načtení neznamená platné PDF.** Soubor s jediným řádkem `%PDF-1.7` se načte
bez chyby a teprve `getPageCount()` spadne. Ověření je proto vícekrokové.

Nahrávání jde přes route handler `/api/knihovna/nahrat`, ne přes Server Action:
ta má výchozí strop těla 1 MB a jeho překročení se vyhodí ještě před spuštěním vlastní
funkce, takže se nedá odchytit. Cesty pod `/api` jsou navíc vyňaté z `proxy.ts` –
kdyby je proxy chytala, Next by tělo nabufferoval s vlastním limitem a přes něj
by soubor **mlčky usekl**.

## Jak funguje přihlašování

Dvoufázové přihlášení je povinné a vede k němu jediná cesta:

1. E-mail a heslo. Heslo se ověřuje argon2id a **vždy**, i když uživatel neexistuje –
   proti návnadě, aby se podle doby odpovědi nedalo zjistit, kdo tu účet má.
2. Relace vznikne hned, ale s nepotvrzeným druhým faktorem neotevírá nic než obrazovku
   pro jeho zadání.
3. Po ověření kódu se **token relace vymění**. Bez toho by hodnota získaná před druhým
   faktorem po něm začala platit naplno, což je session fixation.

Relace je řádek v databázi, ne podepsaný token. Odhlášení se tak projeví okamžitě
a vypršení při nečinnosti je skutečné. Posouvá se jen záznam v databázi, ne cookie –
Next.js dovoluje zápis cookie výhradně v Server Action, Route Handleru a v proxy,
takže při vykreslování stránky by to skončilo chybou za běhu.

### Když se někdo nedostane dovnitř

Dvoufázové přihlášení je povinné, takže ztráta telefonu by bez cesty zpět znamenala
trvalé zamčení účtu. Správce ordinace proto v `/nastaveni` u každého uživatele nastaví
nové jednorázové heslo nebo zruší druhý faktor. Obojí smí udělat **i sám sobě** – v malé
ordinaci bývá jediný.

Obě akce ruší všechny relace dotčeného účtu. Kdo žádá o obnovu přístupu, má typicky
podezření, že se k účtu dostal někdo další; ponechat běžící přihlášení by obnovu
vyprázdnilo. Nové heslo se zobrazí jednou a předává se osobně – aplikace hesla
neposílá e-mailem, protože schránka bývá v ordinaci sdílená a zprávy se z ní nemažou.

Kontrola přihlášení sedí ve stránkách a v přístupové vrstvě, **ne v layoutu**. Layout se
při navigaci nevykresluje znovu a nerozhoduje o tom, jestli se zbytek cesty vykreslí –
není to bezpečnostní hranice.

### Poznámka k migracím

Částečný unikátní index `handoff_activation_jedna_aktivni` (jedna aktivní
aktivace na ordinaci), politiky RLS, granty a triggery auditu žijí v ručně
psaných migracích. Prisma je nesleduje, takže je při generování migrací
neshodí – ale taky je sama neobnoví. Po `prisma migrate reset` se přehrají
znovu z migrací, což je v pořádku.

Trigramový index na názvu problému v databázi **není**. Nejdřív tam byl, měření ho
poslalo pryč (migrace `20260917131939_bez_trigramoveho_indexu`): podmínka row-level
security je security qual a PostgreSQL ji musí vyhodnotit první, kdežto operátory
`pg_trgm` nejsou LEAKPROOF a smí se uplatnit až po ní. Plánovač proto vždycky sáhne
po indexu na `practice_id` a trigram by zůstal jen filtrem nad už zúženou množinou.
Při velikosti jedné ordinace se hledá pod milisekundu i bez něj.

## Stav prací

| Etapa | Obsah | Stav |
|---|---|---|
| 0 | Schéma, RLS, role, neměnný audit, šifrování, bezpečnostní hlavičky | hotovo |
| a | Auth: heslo + TOTP, session, role, ordinace, uživatelé | hotovo |
| b | Knihovna: problémy, dokumenty, verze, hledání | hotovo |
| c | Příprava balíčku + tisk | hotovo |
| d | NFC předání: čipy, aktivace, kód, stránka pacienta | hotovo |
| e | Odeslání e-mailem s PINem | hotovo |
| f | Historie, auditní deník, zneplatnění odkazu, úklid po expiraci | hotovo |
| g | Vývojová data, README, návod k nasazení | hotovo |

Návod na zápis adresy na NFC čip není v dokumentaci, ale přímo v aplikaci na
`/nastaveni/cip` – čip zapisuje personál ordinace, ne správce, a v README by se k němu
nedostal.

Co zbývá: rotace `FILE_MASTER_KEY`, změna hesla z aplikace a Dockerfile.

## Konvence

Identifikátory v kódu jsou anglicky, stejně jako modely v Prismě. Komentáře,
uživatelské rozhraní, adresy stránek a dokumentace jsou česky – adresy proto,
že je pacient i lékař vidí.
