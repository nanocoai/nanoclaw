\set ON_ERROR_STOP on

-- Connect as nanoclaw_runtime. This proves the role has DML but cannot create
-- schema objects or perform table-owner operations.
DO $$
DECLARE
  candidate record;
BEGIN
  IF has_schema_privilege(current_user, 'nanoclaw', 'CREATE') THEN
    RAISE EXCEPTION 'runtime role unexpectedly has CREATE on schema nanoclaw';
  END IF;

  FOR candidate IN SELECT tablename FROM pg_tables WHERE schemaname = 'nanoclaw'
  LOOP
    IF NOT has_table_privilege(
      current_user,
      format('%I.%I', 'nanoclaw', candidate.tablename),
      'SELECT,INSERT,UPDATE,DELETE'
    ) THEN
      RAISE EXCEPTION 'runtime role lacks required DML on nanoclaw.%', candidate.tablename;
    END IF;
    IF has_table_privilege(
      current_user,
      format('%I.%I', 'nanoclaw', candidate.tablename),
      'TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION 'runtime role has owner-level privileges on nanoclaw.%', candidate.tablename;
    END IF;
  END LOOP;
END
$$;

SELECT current_user AS verified_runtime_role, COUNT(*) AS schema_version_rows
FROM nanoclaw.schema_version;
