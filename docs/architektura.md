# MedPředání — architektura a datový model

Návrh k odsouhlasení před začátkem implementace. Verze 1, 17. 9. 2026.

---

## 1. Tech stack a hosting

| Vrstva | Volba | Poznámka |
|---|---|---|
| Framework | Next.js 15 (App Router), TypeScript, React 19 | Server Actions pro formuláře, Route Handlers pro streamování souborů |
| UI | Tailwind CSS + vlastní komponenty | Žádná komponentová knihovna navíc; UI je malé a specifické |
| DB | PostgreSQL 16 + Prisma | Row-Level Security zapnutá na všech tenantních tabulkách |
| Úložiště | S3-kompatibilní, EU region | Za rozhraním `FileStorage` (put/get/stream/delete/signUrl) |
| Auth | vlastní session + argon2id + TOTP | Session v DB → okamžité odvolání a reálný session timeout |
| E-mail | za rozhraním `EmailSender` | Implementace: EU poskytovatel (Scaleway TEM / Brevo / Mailjet) |
| PDF | `pdf-lib` | Slučování, převod fotky na stránku, počítání stránek |
| Rate limiting | PostgreSQL tabulka | Žádná další infrastruktura; provoz je řádově desítky akcí/den |
| Cron | systémový cron / container scheduler | Denní úklid expirací |
| Jazyk UI | čeština, napevno | Žádná i18n knihovna, texty v `src/lib/texty.ts` |

**Doporučený deployment:** jeden Docker kontejner na EU VPS (Hetzner Nürnberg/Falkenstein)
+ managed PostgreSQL v EU + S3-kompatibilní storage v EU.
Důvod: stabilní spojení do DB (RLS potřebuje transakce), funkční cron, žádné cold starty,
jednodušší zpracovatelské smlouvy (menší počet subdodavatelů). Vercel je možný, ale vyžaduje
externí cron, pooler a přidává dalšího zpracovatele mimo EU-only řetězec.

---

## 2. Oddělení ordinací (multi-tenancy) — tři vrstvy

Tohle je nejdůležitější bezpečnostní prvek celé aplikace.

**Vrstva 1 — session.** `practiceId` se bere *výhradně* ze serverové session,
nikdy z URL, query parametru ani z těla requestu. Neexistuje endpoint, kterému by se
`practiceId` posílalo.

**Vrstva 2 — Prisma extension.** Tenantní klient vytvořený per-request přes `$extends`
automaticky vkládá `practiceId` do každého `where` a `data` u tenantních modelů.
Zapomenutý filtr v aplikačním kódu tedy neexistuje jako chyba.

**Vrstva 3 — PostgreSQL RLS.** Každá tenantní tabulka má:

```sql
ALTER TABLE package ENABLE ROW LEVEL SECURITY;
ALTER TABLE package FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON package
  USING      (practice_id = current_setting('app.practice_id', true)::uuid)
  WITH CHECK (practice_id = current_setting('app.practice_id', true)::uuid);
```

`current_setting(..., true)` vrátí NULL, když proměnná není nastavená → porovnání je NULL →
**nevrátí se nic**. Chová se tedy fail-closed: chyba v aplikaci znamená prázdný výsledek,
ne únik dat.

Kontext se nastavuje na začátku interaktivní transakce:

```ts
prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.practice_id', ${practiceId}, true)`
  return work(tx)
})
```

*Cena:* každý tenantní request je jedna transakce (drží spojení po dobu requestu).
Při zdejším objemu provozu je to bezvýznamné a je to vědomý kompromis ve prospěch bezpečnosti.

### Dvě databázové role

| Role | Práva | Použití |
|---|---|---|
| `medpredani_owner` | vlastník schématu, DDL | jen `prisma migrate` |
| `medpredani_app` | DML na tenantních tabulkách, **bez BYPASSRLS** | veškerý provoz pod přihlášeným uživatelem i pod pacientským tokenem |
| `medpredani_resolver` | SELECT jen na `practice`, `nfc_tag`, `patient_access_token`, `handoff_activation` (vybrané sloupce) + INSERT do `audit_log` | překlad `slug`/`token` → `practiceId` **předtím**, než je znám tenant |

Pacientské cesty (`/o/...`, `/d/...`) nemají session, takže tenanta neznají.
Nejdřív proto proběhne úzký dotaz rolí `resolver` (jediné, co umí, je najít ordinaci podle
slugu a token podle hashe — vynuceno GRANTy, ne aplikačním kódem), a teprve pak se zbytek
requestu odbaví normálně pod `app` s nastaveným `app.practice_id`.

---

## 3. Šifrování a přístup k souborům

**Klíče.** `FILE_MASTER_KEY` (32 B) v prostředí, ideálně z KMS/secret manageru.
Každý soubor má vlastní DEK (32 B náhodně, AES-256-GCM); DEK je zabalený master klíčem
a uložený u záznamu (`encKeyWrapped`, `encIv`, `encTag`, `keyVersion`).
Objektové úložiště tedy nikdy nevidí čitelný obsah — a to i kdyby selhalo SSE poskytovatele.

**Stejným způsobem se šifrují i citlivá pole v DB:** `Package.patientLabel`, `Package.note`,
`EmailDispatch.recipient`. Důsledek k odsouhlasení: **v historii nejde fulltextově hledat
podle jména pacienta** (jde hledat podle data, problému, uživatele a kanálu).

**Stahování.** Veškeré stahování jde přes route handler aplikace, který
(1) ověří oprávnění, (2) zapíše audit, (3) streamuje dešifrovaný obsah.
Oproti podepsaným URL to dává: přesný audit skutečného stažení (ne jen vydání odkazu),
**okamžité** odvolání (podepsaná URL platí i po revokaci až do vypršení TTL)
a možnost aplikačního šifrování.
Rozhraní `FileStorage` má i `signUrl()`, takže přepnutí na podepsané URL je změna konfigurace,
ne přepis kódu.

---

## 4. Kritické toky

### 4.1 Předání přes NFC

```
LÉKAŘ                                   SERVER                              PACIENT
  │                                       │                                    │
  ├─ „Předat přes NFC" ──────────────────▶│                                    │
  │                        zruší předchozí ACTIVE aktivaci ordinace            │
  │                        kód = 4 číslice (crypto), uloží HMAC(kód, pepper)   │
  │                        expiruje za 180 s (konfigurovatelné)                │
  │◀───────── kód 4821 + odpočet ─────────┤                                    │
  │                                       │                                    │
  │  poll /status á 2 s ─────────────────▶│                                    │
  │                                       │◀── přiloží telefon, /o/<slug>/<t> ─┤
  │                                       ├─── formulář na kód ───────────────▶│
  │                                       │◀── POST kód ───────────────────────┤
  │                        SELECT ... FOR UPDATE (serializace pokusů)          │
  │                        špatně → attemptCount++, při 5. → LOCKED            │
  │                        správně → token 32 B, aktivace CLAIMED              │
  │                                       ├─── 303 → /d/<token> ──────────────▶│
  │◀──── status: CLAIMED → „Předáno ✓" ───┤                                    │
```

Bezpečnostní vlastnosti toku:

- **Jedna aktivní aktivace na ordinaci** — vynuceno částečným unikátním indexem
  `CREATE UNIQUE INDEX ON handoff_activation (practice_id) WHERE status = 'ACTIVE'`.
  Uhodnutý kód tedy nikdy nemůže trefit „nějaký jiný" balíček.
- **Globální čítač pokusů na aktivaci** (ne per-IP) — 5 pokusů celkem, pak `LOCKED`
  a lékař musí předání spustit znovu. Šance na uhodnutí je tedy ≤ 5/10 000 = 0,05 %
  *bez ohledu na počet útočníků a IP adres*. K tomu per-IP rate limit proti spamu.
- **`SELECT ... FOR UPDATE`** uvnitř transakce — souběžné pokusy nemohou čítač obejít.
- **Jednorázovost** — nárokování je atomické, druhé přiložení telefonu nic neukáže.
- **Tajemství na čipu** — URL na čipu je `https://<doména>/o/<slug>/<tagSecret>`.
  Bez tajemství `/o/<slug>` ukáže jen název ordinace a *žádné pole na kód*.
  Útočník na druhém konci světa se tedy k hádání kódu vůbec nedostane.
  Doplňkově `Referrer-Policy: no-referrer` a URL se nelogují celé.
- Hash kódu je **HMAC-SHA256 s pepperem** z prostředí, ne argon2: keyspace je jen 10 000,
  takže pomalý hash nic nezachrání — pepper ano (únik samotné DB kód neprozradí).
  Porovnání je časově konstantní.

Pacientský token: 32 B z CSPRNG → base64url (43 znaků), v DB jen `sha256`.
256 bitů entropie znamená, že prostý SHA-256 je bezpečný a zároveň indexovatelný.

### 4.2 Stránka pacienta `/d/<token>`

- Hlavičky: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, přísné CSP s nonce, `frame-ancestors 'none'`.
  Na této cestě neběží žádný skript třetí strany ani analytika.
- Obsah: seznam dokumentů s velkými tlačítky, „Stáhnout vše jako jedno PDF"
  (slučuje se on-the-fly, neukládá se), „Uložit odkaz" (návod na přidání na plochu),
  „Poslat si odkaz e-mailem".
- Platnost výchozí 30 dní (per-ordinace konfigurovatelné). Po expiraci hláška bez detailů.
- Každé stažení = jeden řádek auditu s IP a user-agentem.

### 4.3 Odeslání e-mailem

E-mail obsahuje **jen odkaz**, žádnou přílohu se zdravotními údaji.
Token pro e-mailový kanál má povinné ověření:

- **PIN (výchozí)** — 6 číslic, zobrazí se lékaři na obrazovce, ten ho řekne pacientovi.
  Nikdy neputuje stejným kanálem jako odkaz.
- **Datum narození** — alternativa; ukládá se jen jako HMAC s pepperem (malý keyspace).

Adresa příjemce se ukládá šifrovaně a při expiraci se maže; pro audit zůstává jen její hash.

### 4.4 Tisk

Sloučení vybraných dokumentů → jedno PDF → skryté same-origin `<iframe>` → `print()`.
Fallback: otevření PDF v nové záložce.

### 4.5 Expirace (denní cron)

Projde balíčky a tokeny po `expiresAt`: odvolá tokeny, **smaže blob nahrané zprávy
i skenů**, vynuluje šifrovaný štítek pacienta a poznámku, nastaví `Package.status = EXPIRED`,
zapíše `FILES_PURGED`. Metadata (kdy, kdo, který problém, které verze šablon) zůstávají
kvůli auditu — bez osobních údajů. Uklidí také vypršelé session, aktivace a rate-limit řádky.

---

## 5. Datový model

```
Practice ──┬── User ── Session
           ├── NfcTag
           ├── Problem ── TemplateDocument ── TemplateDocumentVersion
           ├── Package ──┬── PackageDocument ──▶ TemplateDocumentVersion | UploadedFile
           │             ├── HandoffActivation
           │             ├── PatientAccessToken
           │             └── EmailDispatch
           └── AuditLog
```

Každá tabulka kromě `Session` nese `practiceId` (i tam, kde by šel odvodit přes rodiče) —
RLS politika tak může být na všech stejná a triviálně kontrolovatelná.

### Practice
`id` · `slug` (unikátní, v `/o/<slug>`) · `name` · `addressLine?` ·
`linkTtlDays` (výchozí 30) · `handoffTtlSeconds` (výchozí 180) · `maxCodeAttempts` (výchozí 5) ·
`sessionIdleMinutes` (výchozí 30) · `createdAt` · `updatedAt`

### User
`id` · `practiceId` · `email` (unikátní globálně) · `passwordHash` (argon2id) · `name` ·
`role` = `DOCTOR` | `NURSE` | `PRACTICE_ADMIN` ·
`totpSecretEnc?` · `totpConfirmedAt?` · `recoveryCodeHashes[]` ·
`status` = `ACTIVE` | `DISABLED` · `failedLoginCount` · `lockedUntil?` · `lastLoginAt?`

2FA je povinné: bez `totpConfirmedAt` vede přihlášení rovnou na povinné nastavení TOTP
a jinam se uživatel nedostane.

### Session
`id` · `userId` · `tokenHash` (unikátní) · `createdAt` · `lastSeenAt` ·
`idleExpiresAt` (klouzavé) · `absoluteExpiresAt` (12 h) · `ip` · `userAgent` · `revokedAt?`

### NfcTag
`id` · `practiceId` · `label` · `secretHmac` · `createdById` · `createdAt` ·
`lastSeenAt?` · `revokedAt?`
Tajemství se zobrazí jednou při generování URL. Čipů může být víc (ordinace, sesterna).

### Problem
`id` · `practiceId` · `name` · `icd10?` · `note?` · `sortOrder` · `archivedAt?`
Vyhledávání přes `pg_trgm` index na `name` + přesná shoda na `icd10`.

### TemplateDocument
`id` · `practiceId` · `problemId` · `title` · `sortOrder` · `archivedAt?` · `currentVersionId?`

### TemplateDocumentVersion
`id` · `practiceId` · `templateDocumentId` · `version` · `storageKey` · `sizeBytes` ·
`pageCount` · `sha256` · `encKeyWrapped` · `encIv` · `encTag` · `keyVersion` ·
`uploadedById` · `createdAt`

Balíček si ukládá **verzi**, ne dokument — historie tak zůstane pravdivá i po aktualizaci letáku.

### Package
`id` · `practiceId` · `createdById` · `problemId?` ·
`patientLabelEnc?` · `noteEnc?` ·
`status` = `DRAFT` | `READY` | `HANDED` | `EXPIRED` | `REVOKED` ·
`expiresAt?` (nastaví se při prvním předání) · `createdAt` · `updatedAt` · `purgedAt?`

### PackageDocument
`id` · `practiceId` · `packageId` · `kind` = `TEMPLATE` | `UPLOAD` ·
`templateVersionId?` · `uploadedFileId?` · `title` (snapshot) · `sortOrder`

### UploadedFile
`id` · `practiceId` · `packageId?` · `storageKey` · `sizeBytes` · `pageCount` · `sha256` ·
`mimeType` · `encKeyWrapped` · `encIv` · `encTag` · `keyVersion` ·
`uploadedById` · `createdAt` · `deletedAt?`

### HandoffActivation
`id` · `practiceId` · `packageId` · `nfcTagId?` · `codeHmac` · `expiresAt` ·
`status` = `ACTIVE` | `CLAIMED` | `EXPIRED` | `CANCELLED` | `LOCKED` ·
`attemptCount` · `maxAttempts` · `createdById` · `claimedAt?` · `patientAccessTokenId?`
Částečný unikátní index na `(practiceId) WHERE status = 'ACTIVE'`.

### PatientAccessToken
`id` · `practiceId` · `packageId` · `tokenHash` (unikátní) ·
`channel` = `NFC` | `EMAIL` | `MANUAL` ·
`verificationType` = `NONE` | `PIN` | `DOB` · `verificationHmac?` · `verifiedAt?` ·
`expiresAt` · `revokedAt?` · `revokedById?` ·
`firstAccessedAt?` · `lastAccessedAt?` · `accessCount` · `createdAt`

Jeden balíček může mít víc tokenů (NFC + e-mail) — kanály jdou kombinovat a každý se odvolává
zvlášť.

### EmailDispatch
`id` · `practiceId` · `packageId` · `patientAccessTokenId` ·
`recipientEnc` · `recipientHash` · `status` = `QUEUED` | `SENT` | `FAILED` | `BOUNCED` ·
`providerMessageId?` · `error?` · `sentById` · `createdAt` · `sentAt?`

### AuditLog (append-only)
`id` (bigserial) · `practiceId?` · `seq` (pořadí v rámci ordinace) · `action` ·
`actorType` = `USER` | `PATIENT` | `SYSTEM` · `actorUserId?` ·
`packageId?` · `tokenId?` · `documentId?` · `ip?` · `userAgent?` · `metadata` (jsonb) ·
`prevHash` · `hash` · `createdAt`

Neměnnost je vynucená **dvakrát**:
1. Role `medpredani_app` má na této tabulce jen `INSERT` a `SELECT` — žádné `UPDATE`/`DELETE`.
2. Hashový řetěz: `hash = sha256(prevHash ‖ kanonický JSON řádku)`, per ordinace.
   Vynechaný nebo změněný řádek řetěz rozbije a ověřovací skript to odhalí.

Zaznamenávané akce: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `TOTP_FAILED`, `LOGOUT`,
`PACKAGE_CREATED`, `PACKAGE_UPDATED`, `HANDOFF_ACTIVATED`, `HANDOFF_CODE_FAILED`,
`HANDOFF_LOCKED`, `HANDOFF_CLAIMED`, `HANDOFF_CANCELLED`, `TOKEN_ISSUED`, `TOKEN_REVOKED`,
`PATIENT_PAGE_VIEWED`, `DOCUMENT_DOWNLOADED`, `PACKAGE_PRINTED`, `EMAIL_SENT`,
`TEMPLATE_UPLOADED`, `TEMPLATE_ARCHIVED`, `USER_CREATED`, `USER_DISABLED`,
`NFC_TAG_CREATED`, `NFC_TAG_REVOKED`, `SETTINGS_CHANGED`, `FILES_PURGED`.

### RateLimit
`key` (hash z akce + IP nebo + identifikátoru) · `windowStart` · `count` · `expiresAt`

---

## 6. Role a oprávnění

| Akce | Lékař | Sestra | Admin ordinace |
|---|:--:|:--:|:--:|
| Příprava a předání balíčku (NFC / tisk / e-mail) | ✓ | ✓ | ✓ |
| Historie vlastní ordinace, odvolání odkazu | ✓ | ✓ | ✓ |
| Správa problémů a šablon (nahrát, verzovat, archivovat) | ✓ | — | ✓ |
| Správa uživatelů, NFC čipu, nastavení ordinace | — | — | ✓ |
| Auditní log (čtení) | ✓ | — | ✓ |

Role se dají kombinovat na jednom uživateli (lékař bývá zároveň admin ordinace) —
proto `role` jako pole hodnot, ne jedna hodnota. *(Pokud stačí jedna role na uživatele,
zjednoduším.)*

---

## 7. Mapa cest

**Lékař** (vše za přihlášením + 2FA)
- `/` — příprava balíčku (hlavní obrazovka)
- `/predani/[activationId]` — obrazovka s kódem a odpočtem
- `/knihovna` · `/knihovna/[problemId]` — problémy a jejich dokumenty
- `/historie` · `/historie/[packageId]`
- `/nastaveni` — ordinace, uživatelé, NFC čip, audit (jen admin)
- `/prihlaseni` · `/prihlaseni/overeni` (TOTP) · `/prihlaseni/nastaveni-2fa`

**Pacient** (veřejné)
- `/o/[slug]` — neutrální stránka ordinace
- `/o/[slug]/[tagSecret]` — stránka po přiložení telefonu (pole na kód)
- `/d/[token]` — balíček dokumentů
- `/d/[token]/soubor/[dokumentId]` · `/d/[token]/vse.pdf`

**API**
- `POST /api/predani/aktivovat` · `GET /api/predani/[id]/stav` · `POST /api/predani/[id]/zrusit`
- `POST /api/balicky` · `POST /api/balicky/[id]/nahrat` · `GET /api/balicky/[id]/tisk.pdf`
- `POST /api/balicky/[id]/email` · `POST /api/tokeny/[id]/odvolat`

---

## 8. Hlavní obrazovka — návrh toku

```
┌──────────────────────────────────────────────────────────────────────┐
│  MedPředání                                    MUDr. Nováková  ▾     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   🔍  Hledat problém nebo kód MKN-10            (kurzor je zde)      │
│   ┌────────────────────────────────────────────────────────────┐     │
│   │  Po operaci kolene            Z96.6        4 dokumenty     │     │
│   │  Hypertenze – režimová opatření  I10       3 dokumenty     │     │
│   └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│   Vybráno: Po operaci kolene                     [ změnit ]          │
│   ☑ Poučení po operaci        ☑ Režim prvních 14 dní                 │
│   ☑ Cviky s obrázky           ☐ Informovaný souhlas                  │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐     │
│   │        Přetáhněte sem lékařskou zprávu (PDF)               │     │
│   │        nebo  [ Vybrat soubor ]   [ 📷 Vyfotit ]            │     │
│   └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│   Označení pacienta (nepovinné)  ┌──────────────────────────┐        │
│                                  └──────────────────────────┘        │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│   │ Předat přes  │  │  Vytisknout  │  │   Poslat     │               │
│   │    NFC       │  │              │  │   e-mailem   │               │
│   └──────────────┘  └──────────────┘  └──────────────┘               │
└──────────────────────────────────────────────────────────────────────┘
```

Počet kliků u typického předání: **napsat pár písmen → klik na problém → přetáhnout
zprávu → klik na „Předat přes NFC"**. Balíček se zakládá automaticky na pozadí, nic se
nepotvrzuje.

Fotka z mobilu: `<input accept="image/*,application/pdf" capture="environment">`,
na serveru převod na stránku PDF. *Známé riziko:* iPhone může poslat HEIC — ošetřím
serverovou konverzí a jasnou chybovou hláškou, pokud formát nepůjde zpracovat.

---

## 9. Bezpečnostní hlavičky

`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` ·
CSP s nonce (`default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none';
frame-ancestors 'none'; base-uri 'none'`) · `X-Content-Type-Options: nosniff` ·
`Referrer-Policy: no-referrer` · `Permissions-Policy` s vypnutými senzory ·
na `/d/*` navíc `X-Robots-Tag: noindex` a `Cache-Control: no-store`.

---

## 10. Testy u kritických částí

| Oblast | Co se testuje |
|---|---|
| Tokeny | entropie, ukládá se jen hash, expirace, odvolání, neplatný token nic neprozradí |
| NFC aktivace | správný/špatný kód, vypršení, zamčení po 5 pokusech, **jednorázovost při souběhu** (paralelní nárokování → právě jeden token), jen jedna ACTIVE aktivace na ordinaci |
| Oddělení ordinací | dotaz pod ordinací A nevidí data B — a to i při **záměrně vynechaném** filtru v aplikaci (test padá na RLS) |
| Expirace | cron smaže bloby a osobní pole, audit zůstane |
| Audit | hashový řetěz drží, role nemá právo UPDATE/DELETE |
| Role | sestra nemůže do šablon ani do nastavení |

Vitest + testovací PostgreSQL v Dockeru. Pro tok NFC navíc jeden Playwright test
(dvě relace: lékař + „telefon").

---

## 11. Etapy implementace

| Etapa | Obsah | Výstup |
|---|---|---|
| **0** | Skeleton, Prisma schéma, RLS migrace, role, hlavičky, CI | **hotovo** |
| **a** | Auth: heslo + TOTP, session, role, ordinace, uživatelé | **hotovo** |
| **b** | Knihovna: problémy, dokumenty, verze, upload, hledání | **hotovo** |
| **c** | Příprava balíčku + tisk | **hotovo** |
| **d** | NFC: čip, aktivace, kód, stránka pacienta | **hotovo** |
| **e** | E-mail s ověřením | **hotovo** |
| **f** | Historie, audit, odvolání, cron expirace | **hotovo** |
| **g** | Seed data, README, návod na zápis čipu | **hotovo** |

Testy z bodu 10 vznikají průběžně v etapách, kterých se týkají, ne až na konci.

---

## 12. Co je potřeba odsouhlasit

1. **Stahování přes aplikaci** místo podepsaných URL (zadání říká podepsané URL).
   Důvod: přesný audit, okamžité odvolání, aplikační šifrování. Rozhraní umí obojí.
2. **Tajemství na NFC čipu** v URL (`/o/<slug>/<tagSecret>`) — díky němu stačí 4místný kód.
   Bez něj bych doporučil 6místný.
3. **Hosting**: jeden kontejner na EU VPS vs. Vercel + managed služby.
4. **Vlastní auth** (session v DB + argon2id + TOTP) vs. Auth.js.
5. **Šifrované jméno pacienta** → v historii nejde hledat podle jména.
6. **Role jako množina** na uživateli (lékař + admin současně) vs. jedna role.

---

## 12b. Co změnilo měření (etapa b)

Průzkum knihoven před psaním kódu odhalil pět věcí, které návrh upravily:

| Zjištění | Důsledek |
|---|---|
| Row-level security platí i pro `$queryRaw` uvnitř `withPractice()` | Hledání může být syrové SQL bez filtru na ordinaci. Ověřeno testem, který filtr schválně vynechává. |
| Kontroly cizích klíčů RLS **obcházejí** | Dokument ordinace A šlo navázat na problém ordinace B. Vazby proto nesou `practice_id` a jsou složené. |
| Trigramový index se pod aplikační rolí nikdy nepoužije | Podmínka RLS je security qual a vyhodnocuje se první; operátory pg_trgm nejsou LEAKPROOF. Index odstraněn. |
| `%` s výchozím prahem nenajde „koleno" v „Po operaci kolene" | Podobnost celých řetězců je 0,25. Používá se `word_similarity` s operátorem `<%` a hledaný výraz stojí vlevo. |
| Parser pdf-libu se dá zahltit souborem s hlavičkou PDF a smetím | Parsování i slučování běží v odděleném vlákně s tvrdým časovým limitem. |

## 13. Rozhodnutí (17. 9. 2026)

| # | Rozhodnuto |
|---|---|
| 1 | **Stahování se streamuje přes aplikaci.** Aplikační šifrování AES-256-GCM, `FileStorage.signUrl()` zůstává v rozhraní jako konfigurační přepínač. |
| 2 | **NFC URL obsahuje tajemství čipu** — `/o/<slug>/<tagSecret>`. Kód zůstává 4místný. |
| 3 | **Docker na EU VPS** + managed PostgreSQL v EU + S3-kompatibilní úložiště v EU. |
| 4 | **Vlastní auth** — session v DB, argon2id, TOTP. |
| 5 | **Jméno pacienta se šifruje.** V historii se hledá podle data, problému, uživatele a kanálu. |
| 6 | **Role jsou množina** na uživateli (`roles: Role[]`) — lékař může být zároveň admin ordinace. |
