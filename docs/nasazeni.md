# Nasazení MedPředání do produkce

Návod pro správce, který aplikaci vidí poprvé. Vede od prázdného serveru k běžící
ordinaci. Příkazy jsou napsané tak, aby se daly zkopírovat a spustit; všude, kde je
`ordinace.example.cz`, doplňte svou doménu.

Aplikace pracuje se zdravotní dokumentací. Dvě věci, které se dělají jinak než jinde
a nedají se dohnat později, jsou zvýrazněné v textu: **běžící aplikace nesmí znát
`DATABASE_URL`** a **reverzní proxy musí hlavičku `x-forwarded-for` přepisovat, ne
k ní přidávat**.

Architektura a zdůvodnění návrhu jsou v [architektura.md](architektura.md).
Přehled aplikace a vývojové prostředí v [../README.md](../README.md).

---

## 1. Co je potřeba

| Součást | Požadavek | Poznámka |
|---|---|---|
| Node.js | 22 nebo novější | `package.json` vyžaduje `>=22` |
| PostgreSQL | 16 | S rozšířeními `pgcrypto` a `pg_trgm`; migrace si je zapnou samy |
| Úložiště souborů | S3-kompatibilní, region v EU | Scaleway, Hetzner, OVH, MinIO na vlastním serveru |
| SMTP | poskytovatel v EU | Obsah e-mailu je jen odkaz, ale adresa pacienta je osobní údaj |
| Doména | vlastní, s HTTPS certifikátem | Bez HTTPS aplikace v produkci nenastartuje |
| Reverzní proxy | nginx, Caddy nebo Traefik | Ukončuje TLS a dodává skutečnou IP adresu klienta |

Provoz jedné ordinace jsou řádově desítky předání denně. Stačí jeden malý server
(2 jádra, 4 GB RAM) plus managed PostgreSQL. Všechny součásti mají být v EU – ordinace
za ně uzavírá zpracovatelské smlouvy a každý poskytovatel mimo EU ten řetězec komplikuje.

Aplikace ukládá do úložiště **zašifrovaný obsah** (AES-256-GCM, klíč zná jen aplikace),
takže poskytovatel úložiště vidí jen neprůhledné bajty. Není to důvod na úložiště
rezignovat: koš musí být privátní, bez anonymního čtení a bez veřejného výpisu obsahu.

---

## 2. Databáze a tři role

Založení databáze a rolí je hotový skript [`scripts/priprav-db.sql`](../scripts/priprav-db.sql).
Spouští se **jednou**, jako superuživatel:

```bash
sudo -u postgres psql -d postgres -f scripts/priprav-db.sql
```

Skript zakládá i testovací databázi `medpredani_test` pro vitest. Na produkčním serveru
ji hned zahoďte:

```bash
sudo -u postgres psql -d postgres -c 'DROP DATABASE IF EXISTS medpredani_test;'
```

### Proč tři role

Oddělení ordinací se nesmí opírat jen o to, že si programátor při psaní dotazu vzpomene
na filtr. Vynucuje ho PostgreSQL, a k tomu jsou potřeba role s různými právy:

| Role | K čemu | Co smí |
|---|---|---|
| `medpredani_owner` | **jen migrace a seed** | Vlastní schéma, mění strukturu, vidí všechna data. Běžící aplikace ji nezná. |
| `medpredani_app` | běžný provoz | Nemá `BYPASSRLS`. Každý dotaz vidí jen řádky té ordinace, jejíž id je v `app.practice_id`. Když kontext chybí, nevidí **nic**. |
| `medpredani_resolver` | překlad identity | Session cookie → uživatel, slug ordinace → ordinace, pacientský token → ordinace. Veřejné cesty a přihlášení ordinaci ještě neznají, teprve ji zjišťují. |

Rozlišovací role je úzká záměrně a to, co smí, je dané `GRANT`y v migraci
`20260917090000_rls_role_audit`, ne důvěrou v aplikační kód. Přesně:

- `practice`, `nfc_tag`: čtení všech řádků – překlad slugu a tajemství čipu na ordinaci.
- `user`: čtení všech řádků včetně hashe hesla (přihlášení musí uživatele dohledat podle
  e-mailu napříč ordinacemi). **Zápis** jen do sloupců `failed_login_count`, `locked_until`,
  `last_login_at`, `updated_at` – heslo, role ani druhý faktor měnit nemůže.
- `patient_access_token`: čtení jen vybraných sloupců (id, ordinace, balíček, hash tokenu,
  kanál, druh ověření, platnost). Sloupec `verification_hmac` – hash PINu – jí grant
  vůbec nedává; PIN se ověřuje až pod aplikační rolí.
- `session`, `rate_limit`: plná práva. Aplikační role na `session` naopak nemá žádná.
- `audit_log`: jen `INSERT`, a jen pro záznamy bez ordinace (pokus o přihlášení na
  neznámý e-mail). Záznamy s ordinací zapisuje aplikační role – hashový řetěz totiž
  potřebuje číst předchozí záznam.

**Běžící aplikace `DATABASE_URL` nezná a znát nesmí.** Role vlastníka obchází oddělení
ordinací (politika `owner_migrace` vidí všechno) a umí měnit strukturu databáze. Kdyby se
dostala do prostředí aplikace, byla by celá vrstva row-level security jen dekorace.
Prakticky to znamená dva různé soubory s proměnnými: jeden pro službu, druhý pro migrace.

### Hesla rolí

Skript zakládá role s vývojovým heslem `vyvoj-heslo`. **Před prvním připojením je změňte:**

```bash
# Vygenerujte tři hesla. hex je bezpečný v URL – nemá znaky, které by se musely kódovat.
openssl rand -hex 24   # → owner
openssl rand -hex 24   # → app
openssl rand -hex 24   # → resolver

sudo -u postgres psql -d postgres <<'SQL'
ALTER ROLE medpredani_owner    PASSWORD 'sem-heslo-owner';
ALTER ROLE medpredani_app      PASSWORD 'sem-heslo-app';
ALTER ROLE medpredani_resolver PASSWORD 'sem-heslo-resolver';
SQL
```

### Přehrání schématu

Práva k tabulkám, politiky row-level security, triggery auditu a částečný unikátní index
na aktivace jsou součástí migrací, ne zakládacího skriptu – `prisma migrate reset` totiž
schéma `public` zahodí a založí znovu, čímž by se granty udělené skriptem ztratily.

```bash
DATABASE_URL="postgresql://medpredani_owner:HESLO@localhost:5432/medpredani?schema=public&sslmode=require" \
  npx prisma migrate deploy
```

U managed databáze nechte `sslmode=require` ve všech třech připojovacích řetězcích.
Migrace se spouští při každém nasazení nové verze, před restartem aplikace.

Seed (`npm run db:seed`) do produkce **nepatří**: zakládá účty se známým heslem. Skript se
v produkci sám odmítne spustit, ale nespoléhejte na to a nepouštějte ho.

---

## 3. Proměnné prostředí

Vzor je [`.env.example`](../.env.example), ověření při startu dělá
[`src/lib/env.ts`](../src/lib/env.ts) – aplikace radši spadne hned, než aby běžela bez
šifrovacího klíče.

Na serveru dejte proměnné do souboru, který čte jen služba:

```bash
sudo install -d -m 700 -o root -g root /etc/medpredani
sudo install -m 600 /dev/null /etc/medpredani/prostredi
```

### Databáze a běh

| Proměnná | Povinná | Význam |
|---|---|---|
| `NODE_ENV` | ano | `production`. Zapíná přísnější kontroly a výchozí ovladač úložiště `s3`. |
| `APP_DATABASE_URL` | ano | Připojení rolí `medpredani_app`. |
| `RESOLVER_DATABASE_URL` | ano | Připojení rolí `medpredani_resolver`. |
| `DATABASE_URL` | **ne** | Role vlastníka. Do prostředí běžící aplikace **nepatří** – jen k migracím. |
| `APP_URL` | ano | Veřejná adresa včetně schématu. V produkci musí začínat `https://`, jinak aplikace nenastartuje. Používá se pro odkazy na čipu, v e-mailech a pro kontrolu původu požadavku. |

```
NODE_ENV="production"
APP_DATABASE_URL="postgresql://medpredani_app:HESLO@localhost:5432/medpredani?schema=public&sslmode=require"
RESOLVER_DATABASE_URL="postgresql://medpredani_resolver:HESLO@localhost:5432/medpredani?schema=public&sslmode=require"
APP_URL="https://ordinace.example.cz"
```

### Klíče

| Proměnná | Jak vygenerovat | Význam |
|---|---|---|
| `FILE_MASTER_KEY` | `openssl rand -base64 32` | Obálkové šifrování souborů a citlivých polí (jméno pacienta, poznámka, adresa příjemce, tajemství druhého faktoru). |
| `SECRET_PEPPER` | `openssl rand -base64 32` | HMAC krátkých tajemství: kód předání, PIN, datum narození, tajemství NFC čipu. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | `openssl rand -base64 32` | Šifrování uzávěrů Server Actions. Viz níže – **musí být nastavený už při buildu**. |

Všechny tři musí být přesně 32 bajtů v base64 a **každý jiný**. Jinou délku aplikace
odmítne a nenastartuje.

> **Ztráta `FILE_MASTER_KEY` je ztráta všech souborů a jmen pacientů.**
> Klíč se nikde neukládá vedle dat; bez něj je záloha databáze i obsah úložiště
> nečitelný balík bajtů a neexistuje způsob, jak ho dostat zpátky. Zálohujte ho
> **odděleně od databáze a od úložiště** – kdo má obojí na jednom místě, má všechno.
> Ztráta `SECRET_PEPPER` je mírnější: zneplatní běžící aktivace předání a vydané PINy,
> ale dokumenty zůstanou čitelné. Zálohuje se stejně.

### `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` a build

Tahle hodnota **není** jen šifrovací klíč. Je zároveň solí pro hash identifikátorů Server
Actions. Když při buildu chybí, Next.js si vygeneruje náhodnou – a každý build pak dostane
jiná ID akcí. Po nasazení přestanou fungovat i formuláře, které žádnou hodnotu
neuzavírají, tedy **i přihlašovací formulář**. Projeví se to až v prohlížeči uživatele,
ne v logu serveru.

Proto se předává už buildu, ne až běhu. Klíč si jednou uložte stranou, ať se při každém
dalším buildu použije **ta samá hodnota**:

```bash
openssl rand -base64 32 | sudo tee /etc/medpredani/actions-key > /dev/null
sudo chmod 600 /etc/medpredani/actions-key

NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(sudo cat /etc/medpredani/actions-key)" npm run build
```

Stejnou hodnotu dejte i do prostředí běžící aplikace – v produkci bez ní aplikace
nenastartuje.

Hodnota končí v build artefaktu, takže to nesmí být `FILE_MASTER_KEY` ani `SECRET_PEPPER` –
ty patří výhradně do běhu. Při buildu se načítá `src/lib/env.ts`, takže ostatní proměnné
musí být k dispozici také; kontroly, které se týkají běhu (HTTPS v `APP_URL`, počet proxy),
se během buildu přeskakují.

### Úložiště

| Proměnná | Povinná | Význam |
|---|---|---|
| `STORAGE_DRIVER` | ne | `s3` nebo `filesystem`. V produkci se dopočítá na `s3`. |
| `STORAGE_ENDPOINT` | ano (u `s3`) | Adresa API úložiště, např. `https://s3.fr-par.scw.cloud`. |
| `STORAGE_REGION` | ano (u `s3`) | Např. `fr-par`, `eu-central-1`. |
| `STORAGE_BUCKET` | ano (u `s3`) | Název koše. Privátní, bez veřejného čtení. |
| `STORAGE_ACCESS_KEY_ID` | ano (u `s3`) | Přístupový klíč. |
| `STORAGE_SECRET_ACCESS_KEY` | ano (u `s3`) | Tajný klíč. |
| `STORAGE_FORCE_PATH_STYLE` | ne | `true` u vlastních endpointů (Scaleway, Hetzner, MinIO). |
| `STORAGE_LOCAL_DIR` | ne | Adresář pro `filesystem`. Výchozí `./uploads-dev`. Pro produkci nedoporučeno. |

Chybějící proměnná u ovladače `s3` aplikaci zastaví při startu s výpisem, co konkrétně
schází.

### E-mail

| Proměnná | Povinná | Význam |
|---|---|---|
| `EMAIL_DRIVER` | **ano, `smtp`** | Ovladač `console` nic neodešle a vypíše celý text zprávy včetně pacientského odkazu `/d/<token>` do logu aplikace – tedy přístup k dokumentaci. Aplikace proto v produkci s `console` **odmítne nastartovat**. |
| `EMAIL_FROM` | ano | Odesílatel, na vlastní doméně. Vyplňte i při `console`. |
| `SMTP_HOST` | ano (u `smtp`) | Server poskytovatele. |
| `SMTP_PORT` | ne | Výchozí 587 (STARTTLS). Port 465 aplikace pozná a použije TLS od začátku. TLS se vyžaduje vždy. |
| `SMTP_USER`, `SMTP_PASSWORD` | podle poskytovatele | Bez uživatele se posílá bez přihlášení. |

Pro doménu v `EMAIL_FROM` nastavte SPF, DKIM a DMARC – jinak e-maily s odkazem skončí
v nevyžádané poště a pacient je nenajde.

### Úklid po expiraci

| Proměnná | Povinná | Význam |
|---|---|---|
| `CLEANUP_TOKEN` | pro cron ano | Tajemství, kterým se cron prokazuje. Nejméně 24 znaků. Bez něj se cesta `/api/udrzba/uklid` tváří, že neexistuje. |

```bash
openssl rand -base64 32 | sudo tee /etc/medpredani/uklid-token > /dev/null
sudo chmod 600 /etc/medpredani/uklid-token
```

### Reverzní proxy: `TRUSTED_PROXY_HOPS`

| Proměnná | Význam |
|---|---|
| `TRUSTED_PROXY_HOPS` | Kolik vlastních proxy stojí před aplikací. `0` znamená, že se hlavičce `x-forwarded-for` nevěří vůbec a IP adresy v auditu zůstanou prázdné; aplikace na to v produkci při startu upozorní v logu. Jedna nginx nebo Caddy před aplikací = `1`. |

Next.js 16 žádné API pro IP adresu klienta nemá. Jediným zdrojem je hlavička
`x-forwarded-for` a Next ji **doplní jen tehdy, když úplně chybí**. Když si ji klient
pošle sám, Next ji nechá být a skutečnou adresu nikam nepřipojí – je z požadavku
nenávratně pryč.

Proto platí obojí najednou:

1. Proxy musí `x-forwarded-for` **přepsat** svou hodnotou, ne k té klientově přidávat.
2. `TRUSTED_PROXY_HOPS` musí sedět s počtem vlastních proxy. Aplikace čte hlavičku zprava:
   nejpravější položku přidala nejbližší vlastní proxy.

Bez toho jsou IP adresy v auditním deníku i v omezování četnosti podle IP pod kontrolou
útočníka. Stejně tak musí proxy přepisovat `x-forwarded-host`: Next jí dává přednost před
`host` a nijak ji neověřuje, takže by se jí dala předstírat shoda původu požadavku.

#### nginx

**Pozor: často doporučované `proxy_add_x_forwarded_for` je pro tenhle účel špatně** –
zachová hodnotu, kterou poslal klient, a jen k ní připojí svou. Použijte `$remote_addr`.

```nginx
server {
    listen 80;
    server_name ordinace.example.cz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name ordinace.example.cz;

    ssl_certificate     /etc/letsencrypt/live/ordinace.example.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ordinace.example.cz/privkey.pem;

    # Lékařská zpráva a skeny: strop aplikace je 20 MB, s režií multipartu 25 MB.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;

        # PŘEPSAT, ne přidat. proxy_add_x_forwarded_for by hodnotu od klienta ponechal.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;

        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;

        # Sloučení většího balíčku do jednoho PDF chvíli trvá.
        proxy_read_timeout 120s;
    }
}
```

S touhle konfigurací nastavte `TRUSTED_PROXY_HOPS="1"`.

#### Caddy

Caddy k existující hlavičce `X-Forwarded-For` ve výchozím nastavení připojuje adresu
klienta, takže se přepis zapisuje výslovně:

```caddy
ordinace.example.cz {
    request_body {
        max_size 25MB
    }

    reverse_proxy 127.0.0.1:3000 {
        # Přepis, ne doplnění.
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Host {host}
    }
}
```

Také `TRUSTED_PROXY_HOPS="1"`. Certifikát si Caddy obstará sám.

#### Když je před aplikací víc vrstev

CDN, WAF nebo load balancer navíc znamená vyšší číslo: `TRUSTED_PROXY_HOPS` = počet
vlastních proxy, které do hlavičky zapisují. Ověřte to po nasazení – v auditním deníku
(sloupec `ip`) musí být adresy pacientů a personálu, ne adresa vaší proxy.

---

## 4. Build a spuštění

Repozitář zatím Dockerfile neobsahuje; níže je postup se systemd. V kontejneru platí totéž
včetně klíče při buildu.

```bash
npm ci
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(sudo cat /etc/medpredani/actions-key)" npm run build
```

`npm run build` spouští `prisma generate` a pak `next build`.

Služba (`/etc/systemd/system/medpredani.service`):

```ini
[Unit]
Description=MedPredani
After=network.target

[Service]
Type=simple
User=medpredani
WorkingDirectory=/opt/medpredani
EnvironmentFile=/etc/medpredani/prostredi
# -H 127.0.0.1: zvenčí se k aplikaci dostane jen přes reverzní proxy.
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1 -p 3000
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now medpredani
sudo systemctl status medpredani
```

Pořadí při každém dalším nasazení: `prisma migrate deploy` → build → restart služby.

---

## 5. Cron: úklid po expiraci

Po uplynutí platnosti odkazu se **maže obsah** – soubory v úložišti, jméno pacienta,
poznámka, adresa příjemce e-mailu. Metadata a auditní deník zůstávají, aby šlo dohledat,
kdy a kdo co předal. Je to slib daný pacientovi, ne úspora místa, a drží ho tenhle cron.

Úklid se spouští HTTP požadavkem na `/api/udrzba/uklid` s hlavičkou `X-Uklid-Token`.
Běží uvnitř aplikace, protože potřebuje šifrovací klíč a přístup k úložišti; samostatný
skript by byl druhý kus kódu, který sahá na zdravotní dokumentaci.

Řádek do crontabu (`sudo crontab -e`):

```cron
0 3 * * * curl -fsS -m 900 -X POST -H "X-Uklid-Token: $(cat /etc/medpredani/uklid-token)" https://ordinace.example.cz/api/udrzba/uklid > /dev/null
```

Ve tři ráno, každý den. `-f` znamená, že se chybový stav (500, 404) projeví nenulovým
návratovým kódem, `-S` k tomu vypíše důvod na chybový výstup – a ten cron pošle mailem.
Tělo úspěšné odpovědi se zahazuje, ať nechodí mail po každém běhu. Limit 900 s pokrývá
i první běh po delší odstávce, kdy je co mazat.

Odpovědi:

| Stav | Význam |
|---|---|
| 200 | Hotovo. V těle je počet uklizených balíčků, souborů, odkazů, aktivací, relací a počítadel. |
| 500 | Část ordinací se neuklidila. Podrobnosti jsou v logu aplikace i v těle odpovědi. Spusťte znovu – úloha je opakovatelná. |
| 404 | Špatný nebo chybějící token. Cesta se navenek tváří, že neexistuje. |
| 503 | `CLEANUP_TOKEN` není v prostředí aplikace. |

Po nasazení spusťte příkaz jednou ručně a podívejte se na odpověď. Cron, který nikdy
neproběhl, se pozná jen tím, že po měsíci nic nezmizelo.

---

## 6. Zálohování

Zálohují se **tři věci** a každá na jiné místo:

| Co | Jak | Kam |
|---|---|---|
| Databáze | `pg_dump -Fc` denně | Šifrovaný offsite úložný prostor |
| Úložiště souborů | replikace koše nebo `rclone sync` | Jiný poskytovatel nebo jiný region |
| Klíče a hesla rolí | ručně, jednou | Správce hesel, případně obálka v trezoru ordinace |

```bash
pg_dump -Fc \
  "postgresql://medpredani_owner:HESLO@localhost:5432/medpredani?sslmode=require" \
  -f "/zalohy/medpredani-$(date +%F).dump"
```

**Proč odděleně.** Obsah souborů i jména pacientů jsou šifrované klíčem
`FILE_MASTER_KEY`, který v databázi ani v úložišti není. Kdo získá zálohu databáze,
nezíská nic čitelného. Kdo získá zálohu **a k ní klíč**, získá všechno. Proto klíče
nepatří do stejného úložiště, na stejný server ani do stejného zálohovacího účtu jako
data. Opačným směrem platí totéž: klíč bez zálohy je k ničemu, ale ztráta klíče je
nevratná ztráta dat – záloha databáze bez něj obnovit nejde.

Zálohovat je potřeba tyhle hodnoty: `FILE_MASTER_KEY`, `SECRET_PEPPER`,
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `CLEANUP_TOKEN` a hesla tří databázových rolí.

**Obnovu vyzkoušejte, dokud ji nepotřebujete.** Nejméně jednou za půl roku: obnovte dump
do prázdné databáze, nastavte instanci se stejným `FILE_MASTER_KEY` a otevřete jeden
dokument. Záloha, ze které se nikdy nic neobnovilo, není záloha.

---

## 7. Kontrolní seznam před spuštěním

- [ ] **HTTPS** platí na doméně a certifikát se obnovuje sám. `http://` přesměrovává na `https://`.
- [ ] **HSTS** dorazí až do prohlížeče: `curl -sI https://ordinace.example.cz | grep -i strict-transport` vrátí `max-age=63072000; includeSubDomains; preload`. Hlavičku posílá aplikace, proxy ji nesmí zahodit. Doménu do seznamu preload přidávejte, až když jste si jistí, že na ní nikdy nepoběží nic bez HTTPS.
- [ ] **`x-forwarded-for` se přepisuje** a `TRUSTED_PROXY_HOPS` sedí. Po prvním přihlášení má záznam v auditu vyplněnou IP adresu, a je to adresa klienta, ne proxy.
- [ ] **Běžící aplikace nezná `DATABASE_URL`.** V souboru `/etc/medpredani/prostredi` nesmí být: `sudo grep -c '^DATABASE_URL' /etc/medpredani/prostredi` musí vrátit `0`. V kontejneru `docker exec medpredani env | grep DATABASE_URL` nesmí vrátit nic.
- [ ] **Soubor s proměnnými má práva 600** a vlastní ho uživatel služby nebo root.
- [ ] **Druhý faktor má každý účet.** V aplikaci `/nastaveni`, sloupec „Dvoufázové ověření“ – nikde nesmí být „Chybí“. Aplikace bez něj dovnitř nikoho nepustí, ale nenastavený účet znamená, že se ještě nikdo nepřihlásil.
- [ ] **Druhý faktor i u účtů kolem aplikace**: hosting, DNS, úložiště, poskytovatel SMTP, zálohy. Ta nejslabší brána rozhoduje.
- [ ] **NFC čip je zapsaný, ověřený a zamčený.** Postup je přímo v aplikaci na `/nastaveni/cip`; zamknout ho až po ověření podle kroku 6, zámek je nevratný.
- [ ] **Zkušební předání celou cestou**: příprava balíčku → NFC na skutečném telefonu → tisk → e-mail s PINem. Vyzkoušejte i zadání špatného kódu a zneplatnění odkazu.
- [ ] **Úklid proběhl aspoň jednou** ručním zavoláním a cron je v crontabu.
- [ ] **Obnova ze zálohy vyzkoušená** – databáze i jeden soubor z úložiště.
- [ ] **Seed v produkci nespuštěný.** Kdyby se omylem stalo, účty `lekar@example.cz`, `sestra@example.cz` a `admin@example.cz` mají veřejně známé heslo; okamžitě je zablokujte v `/nastaveni`.

---

## 8. Když je podezření na únik

Pořadí je dané: nejdřív zavřít dveře, pak zjišťovat. Všechny příkazy níže se spouští rolí
vlastníka schématu, tedy tou, kterou běžící aplikace nemá.

```bash
# psql nerozumí parametru ?schema=public z prismovské adresy a odmítl by ji,
# takže se do připojení opisuje jen zbytek.
export PGURL="postgresql://medpredani_owner:HESLO@localhost:5432/medpredani?sslmode=require"
```

### Zneplatnit všechny pacientské odkazy

Odkazy jsou v tabulce `patient_access_token`. Zneplatnění je zápis času do `revoked_at`;
od té chvíle je odkaz mrtvý, i když ještě nevypršel.

```bash
psql "$PGURL" <<'SQL'
UPDATE patient_access_token SET revoked_at = now() WHERE revoked_at IS NULL;
UPDATE handoff_activation  SET status = 'CANCELLED' WHERE status = 'ACTIVE';
SQL
```

Zasáhne to i odkazy, které jsou v pořádku – pacienti je pak dostanou znovu, nová předání
fungují normálně. Jeden konkrétní balíček se zneplatní v aplikaci v Historii tlačítkem
„Zneplatnit“; to se navíc zapíše do auditu jako `TOKEN_REVOKED` i se jménem toho, kdo to
udělal. Zásah přes `psql` se do auditu nezapisuje (deník je pouze pro zápis a trigger
brání jeho úpravě), takže si ho poznamenejte do záznamu o incidentu ručně.

### Odhlásit všechny uživatele

Relace jsou řádky v tabulce `session`, ne podepsané tokeny. Smazání řádku se projeví
okamžitě, při nejbližším požadavku:

```bash
psql "$PGURL" -c 'DELETE FROM session;'
```

Všichni se musí přihlásit znovu heslem i druhým faktorem. Když jde o jeden konkrétní účet,
je lepší cesta `/nastaveni` → Zablokovat: účet se zablokuje a zároveň odhlásí ze všech
zařízení, a zůstane po tom stopa v auditu.

Při podezření na prozrazené heslo účet zablokujte a založte místo něj nový – aplikace
k němu vygeneruje jednorázové heslo a ukáže ho jednou. Změna hesla u stávajícího účtu
zatím v aplikaci není.

### Auditní deník

Deník je tabulka `audit_log`. Je **pouze pro zápis**: aplikační role nemá právo `UPDATE`
ani `DELETE`, trigger zakazuje úpravu i mazání včetně `TRUNCATE` a platí i na vlastníka
schématu. Záznamy jednotlivých ordinací jsou navíc spojené hashovým řetězem – vynechaný
nebo pozměněný řádek řetěz rozbije a je vidět kde.

V aplikaci je deník na dvou místech: časová osa jednoho předání u detailu balíčku
v Historii (`/historie/<id>`) a celý deník ordinace se stránkováním na `/nastaveni/audit`,
který nahoře zároveň ukazuje výsledek ověření hashového řetězu. Obojí vidí lékař a admin
ordinace, sestra ne. Postup přes `psql` níže je záložní cesta pro chvíle, kdy aplikace
neběží:

```bash
# Posledních 200 událostí jedné ordinace.
psql "$PGURL" -c "
  SELECT seq, created_at, action, actor_type, actor_name, host(ip) AS ip, package_id
  FROM audit_log
  WHERE practice_id = 'UUID-ORDINACE'
  ORDER BY seq DESC
  LIMIT 200;"

# Kdo a odkud otevíral pacientské odkazy a komu se nepovedlo ověření.
psql "$PGURL" -c "
  SELECT created_at, action, host(ip) AS ip, user_agent, package_id
  FROM audit_log
  WHERE action IN ('PATIENT_PAGE_VIEWED','DOCUMENT_DOWNLOADED',
                   'PATIENT_VERIFY_FAILED','HANDOFF_CODE_FAILED','HANDOFF_LOCKED')
  ORDER BY id DESC
  LIMIT 200;"

# Mezera v číslování řetězce = někdo sahal do databáze mimo aplikaci.
psql "$PGURL" -c "
  SELECT practice_id, count(*) AS zaznamu, max(seq) AS posledni
  FROM audit_log WHERE seq IS NOT NULL GROUP BY practice_id;"
```

Když se počet záznamů a poslední pořadové číslo neshodují, řetěz je porušený. Úplnou
kontrolu (návaznost hashů) dělá funkce `verifyAuditChain()` ze
[`src/lib/history.ts`](../src/lib/history.ts) – její výsledek je vidět na `/nastaveni/audit`
hned nahoře, takže se na něj nemusí sahat ručně.

### Když unikly klíče

- **`FILE_MASTER_KEY`**: považujte za prozrazený veškerý obsah v úložišti i šifrovaná pole
  v databázi. Automatická výměna klíče zatím není hotová (sloupec `key_version` pro ni
  v datovém modelu připravený je). Okamžitým opatřením je zneplatnit všechny odkazy podle
  postupu výše a zkrátit platnost odkazů v `/nastaveni`; pak vygenerovat nový klíč
  a znovu nahrát dokumenty knihovny.
- **`SECRET_PEPPER`**: vygenerujte nový. Běžící aktivace předání a vydané PINy tím
  přestanou platit, uložené dokumenty zůstanou v pořádku.
- **`CLEANUP_TOKEN`**: vygenerujte nový, změňte ho v prostředí i v crontabu.
- **Heslo databázové role**: `ALTER ROLE ... PASSWORD ...`, pak nová hodnota do
  `/etc/medpredani/prostredi` a restart služby.
- **Tajemství NFC čipu** (podezření na přepsanou nálepku): čip v `/nastaveni/cip`
  odvolejte, nálepku slupte a zapište novou. Odvolaný čip už nikdy neotevře nic.
