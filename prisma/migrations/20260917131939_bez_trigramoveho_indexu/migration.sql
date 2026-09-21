-- Odstranění trigramového indexu problem_name_trgm.
--
-- Pod aplikační rolí se nikdy nepoužije. Podmínka row-level security je
-- takzvaný security qual a PostgreSQL ji musí vyhodnotit jako první; operátory
-- pg_trgm (% , <%, ILIKE) přitom nejsou LEAKPROOF, takže se smí uplatnit až
-- po ní. Plánovač proto sáhne po indexu na practice_id a trigram zůstane jen
-- filtrem nad už zúženou množinou.
--
-- Prakticky to nevadí: při padesáti ordinacích a třech stech problémech na
-- každou se hledá pod milisekundu. Index, který se nikdy nepoužije, jen zdržuje
-- zápis a hlavně tvrdí něco, co není pravda.

DROP INDEX IF EXISTS problem_name_trgm;
