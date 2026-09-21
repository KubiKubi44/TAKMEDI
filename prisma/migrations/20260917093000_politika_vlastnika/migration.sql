-- Politika pro vlastníka schématu.
--
-- FORCE ROW LEVEL SECURITY platí i na vlastníka tabulky. Bez vlastní politiky
-- by tedy medpredani_owner neviděl ani nezapsal nic – což by rozbilo seed
-- a migrace, které pracují s daty.
--
-- DŮLEŽITÉ: tahle role obchází oddělení ordinací. Používá ji výhradně Prisma CLI
-- (migrace, seed) a běžící aplikace k ní NESMÍ mít přístup – v produkčním
-- kontejneru se DATABASE_URL vůbec nepředává, aplikace zná jen APP_DATABASE_URL
-- a RESOLVER_DATABASE_URL.

DO $$
DECLARE
  t text;
  rls_tables text[] := ARRAY[
    'practice', 'user', 'nfc_tag', 'problem', 'template_document',
    'template_document_version', 'package', 'package_document', 'uploaded_file',
    'handoff_activation', 'patient_access_token', 'email_dispatch', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY rls_tables LOOP
    EXECUTE format(
      'CREATE POLICY owner_migrace ON %I FOR ALL TO medpredani_owner
         USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
