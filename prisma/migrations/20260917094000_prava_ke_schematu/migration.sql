-- Právo vidět schéma public.
--
-- Patří sem, a ne do jednorázového scripts/priprav-db.sql: `prisma migrate reset`
-- schéma public zahodí a založí znovu, čímž by se grant ze skriptu ztratil.
-- Bez něj role tabulky ani „nevidí" – PostgreSQL hlásí, že relace neexistuje.

GRANT USAGE ON SCHEMA public TO medpredani_app, medpredani_resolver;
