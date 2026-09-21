-- Založení databáze a rolí pro MedPředání.
-- Spouští se JEDNOU jako superuživatel: psql -f scripts/priprav-db.sql -d postgres
--
-- Vznikají tři role, protože oddělení ordinací se nesmí opírat jen o aplikační kód:
--   owner    – vlastní schéma, dělá migrace, jinde se nepoužívá
--   app      – běžný provoz, NEMÁ BYPASSRLS, podléhá row-level security
--   resolver – jen překlad slugu/tokenu na ordinaci u veřejných pacientských cest;
--              co smí, je dané GRANTy, ne důvěrou v aplikaci

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medpredani_owner') THEN
    CREATE ROLE medpredani_owner LOGIN PASSWORD 'vyvoj-heslo';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medpredani_app') THEN
    CREATE ROLE medpredani_app LOGIN PASSWORD 'vyvoj-heslo';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medpredani_resolver') THEN
    CREATE ROLE medpredani_resolver LOGIN PASSWORD 'vyvoj-heslo';
  END IF;
END
$$;

-- Žádná z rolí nesmí obcházet RLS.
ALTER ROLE medpredani_owner NOBYPASSRLS;
ALTER ROLE medpredani_app NOBYPASSRLS;
ALTER ROLE medpredani_resolver NOBYPASSRLS;

SELECT 'CREATE DATABASE medpredani OWNER medpredani_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'medpredani')\gexec

-- Testovací databáze pro vitest.
SELECT 'CREATE DATABASE medpredani_test OWNER medpredani_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'medpredani_test')\gexec

-- Práva ke schématu a k tabulkám nastavují migrace, ne tenhle skript:
-- `prisma migrate reset` schéma public zahodí a založí znovu, takže by se
-- grant udělený tady ztratil.
\connect medpredani
ALTER SCHEMA public OWNER TO medpredani_owner;

\connect medpredani_test
ALTER SCHEMA public OWNER TO medpredani_owner;
