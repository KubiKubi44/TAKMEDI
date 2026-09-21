-- =============================================================================
-- Oddělení ordinací, práva rolí a neměnný audit
-- =============================================================================
-- Tahle migrace je bezpečnostní jádro aplikace. Chyba v aplikačním kódu nesmí
-- stačit k tomu, aby jedna ordinace viděla data druhé – proto se izolace
-- vynucuje i tady, v databázi.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- Kontext ordinace
-- -----------------------------------------------------------------------------
-- Aplikace nastaví app.practice_id na začátku transakce. Není-li nastavené,
-- funkce vrátí NULL, porovnání v politice vyjde NULL a nevrátí se ŽÁDNÝ řádek.
-- Chyba v aplikaci tedy znamená prázdný výsledek, ne únik dat.

CREATE OR REPLACE FUNCTION app_practice_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.practice_id', true), '')::uuid
$$;

-- -----------------------------------------------------------------------------
-- Row-level security na tenantních tabulkách
-- -----------------------------------------------------------------------------
-- FORCE platí i pro vlastníka tabulky, takže politiku nelze obejít ani omylem
-- spuštěným skriptem pod vlastníkem schématu.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'user', 'nfc_tag', 'problem', 'template_document', 'template_document_version',
    'package', 'package_document', 'uploaded_file', 'handoff_activation',
    'patient_access_token', 'email_dispatch'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_app ON %I FOR ALL TO medpredani_app
         USING (practice_id = app_practice_id())
         WITH CHECK (practice_id = app_practice_id())', t);
  END LOOP;
END
$$;

-- Ordinace se filtruje podle vlastního id, ne podle sloupce practice_id.
ALTER TABLE "practice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "practice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_app ON "practice" FOR ALL TO medpredani_app
  USING (id = app_practice_id())
  WITH CHECK (id = app_practice_id());

-- Audit: aplikační role smí číst a zapisovat jen vlastní ordinaci.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_app_read ON "audit_log" FOR SELECT TO medpredani_app
  USING (practice_id = app_practice_id());
CREATE POLICY tenant_app_write ON "audit_log" FOR INSERT TO medpredani_app
  WITH CHECK (practice_id = app_practice_id());

-- -----------------------------------------------------------------------------
-- Rozlišovací role
-- -----------------------------------------------------------------------------
-- Veřejné pacientské cesty (/o/<slug>, /d/<token>) a přihlašování nemají odkud
-- vzít ordinaci – teprve ji zjišťují. Dělá to tahle role a to, co smí, je dané
-- granty níže, ne důvěrou v aplikační kód.

CREATE POLICY resolver_read ON "practice" FOR SELECT TO medpredani_resolver USING (true);
CREATE POLICY resolver_read ON "user" FOR SELECT TO medpredani_resolver USING (true);
CREATE POLICY resolver_login_update ON "user" FOR UPDATE TO medpredani_resolver
  USING (true) WITH CHECK (true);
CREATE POLICY resolver_read ON "nfc_tag" FOR SELECT TO medpredani_resolver USING (true);
CREATE POLICY resolver_read ON "patient_access_token" FOR SELECT TO medpredani_resolver USING (true);
CREATE POLICY resolver_write ON "audit_log" FOR INSERT TO medpredani_resolver WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Práva rolí
-- -----------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medpredani_app, medpredani_resolver;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medpredani_app, medpredani_resolver;

-- Aplikační role: běžný provoz pod RLS.
GRANT SELECT, UPDATE ON "practice" TO medpredani_app;
GRANT SELECT, INSERT, UPDATE ON "user" TO medpredani_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "nfc_tag", "problem", "template_document", "template_document_version",
  "package", "package_document", "uploaded_file", "handoff_activation",
  "patient_access_token", "email_dispatch"
  TO medpredani_app;

-- Audit je přidávací: žádné UPDATE ani DELETE.
GRANT SELECT, INSERT ON "audit_log" TO medpredani_app;
GRANT USAGE, SELECT ON SEQUENCE "audit_log_id_seq" TO medpredani_app;

-- Počítadla četnosti neobsahují osobní údaje a musí fungovat i před zjištěním
-- ordinace, proto bez RLS a pro obě role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit" TO medpredani_app, medpredani_resolver;

-- Rozlišovací role. Tabulku session vlastní výhradně ona – aplikační role
-- na ni nemá vůbec žádná práva, takže se k cizím přihlášením nedostane.
GRANT SELECT, INSERT, UPDATE, DELETE ON "session" TO medpredani_resolver;
GRANT SELECT ON "practice" TO medpredani_resolver;
GRANT SELECT ON "nfc_tag" TO medpredani_resolver;

-- Přihlášení potřebuje dohledat uživatele podle e-mailu napříč ordinacemi.
GRANT SELECT ON "user" TO medpredani_resolver;
-- Zapisovat smí jen počítadla neúspěšných přihlášení – ne heslo, ne 2FA, ne role.
GRANT UPDATE (failed_login_count, locked_until, last_login_at, updated_at)
  ON "user" TO medpredani_resolver;

-- Z pacientského tokenu stačí zjistit ordinaci a platnost. Sloupec
-- verification_hmac (hash PINu) je mimo – ověřuje se až pod aplikační rolí.
GRANT SELECT (id, practice_id, package_id, token_hash, channel, verification_type,
              expires_at, revoked_at)
  ON "patient_access_token" TO medpredani_resolver;

GRANT INSERT ON "audit_log" TO medpredani_resolver;
GRANT USAGE, SELECT ON SEQUENCE "audit_log_id_seq" TO medpredani_resolver;

-- -----------------------------------------------------------------------------
-- Neměnnost auditu
-- -----------------------------------------------------------------------------
-- Vrstva 1 jsou granty výše (žádné UPDATE/DELETE). Vrstva 2 je hashový řetěz
-- počítaný tady v databázi: aplikace hodnoty seq, prev_hash ani hash neposílá,
-- trigger je vždy přepíše. Vynechaný nebo pozměněný řádek řetěz rozbije.

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_seq  bigint;
  v_prev_hash text;
  v_payload   text;
BEGIN
  NEW.created_at := now();

  IF NEW.practice_id IS NULL THEN
    -- Události bez ordinace (např. pokus o přihlášení na neznámý e-mail).
    -- Neřetězí se, protože rozlišovací role nesmí číst cizí záznamy.
    NEW.seq := NULL;
    NEW.prev_hash := NULL;
  ELSE
    -- Serializace souběžných zápisů bez nutnosti práva UPDATE na tabulce.
    PERFORM pg_advisory_xact_lock(hashtext('audit_log:' || NEW.practice_id::text));

    SELECT seq, hash INTO v_prev_seq, v_prev_hash
      FROM audit_log
     WHERE practice_id = NEW.practice_id AND seq IS NOT NULL
     ORDER BY seq DESC
     LIMIT 1;

    NEW.seq := coalesce(v_prev_seq, 0) + 1;
    NEW.prev_hash := v_prev_hash;
  END IF;

  v_payload := concat_ws('|',
    coalesce(NEW.prev_hash, ''),
    coalesce(NEW.practice_id::text, ''),
    coalesce(NEW.seq::text, ''),
    NEW.action::text,
    NEW.actor_type::text,
    coalesce(NEW.actor_user_id::text, ''),
    coalesce(NEW.package_id::text, ''),
    coalesce(NEW.token_id::text, ''),
    coalesce(NEW.document_id::text, ''),
    coalesce(host(NEW.ip), ''),
    coalesce(NEW.user_agent, ''),
    coalesce(NEW.metadata::text, '{}'),
    to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  );

  NEW.hash := encode(digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log je pouze pro zápis, operace % není povolena', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Platí i pro vlastníka schématu, takže ani ruční skript audit nepřepíše.
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- -----------------------------------------------------------------------------
-- Jedna aktivace předání na ordinaci
-- -----------------------------------------------------------------------------
-- Uhodnutý kód nemůže trefit „nějaký jiný" balíček – v danou chvíli je ve hře
-- vždy nejvýš jeden. Vynuceno indexem, ne kontrolou v aplikaci.

CREATE UNIQUE INDEX handoff_activation_jedna_aktivni
  ON "handoff_activation" (practice_id)
  WHERE status = 'ACTIVE';

-- Poznámka: trigramový index pro vyhledávání problémů je deklarovaný přímo
-- v schema.prisma, aby ho kontrola odchylek při migraci neshodila.
