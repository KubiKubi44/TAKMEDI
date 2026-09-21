-- Doplnění actor_name do hashového řetězu.
-- Každé pole, které v auditu něco znamená, musí být pod hashem – jinak by
-- tamper-evidence měla díru.

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
    coalesce(NEW.actor_name, ''),
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
