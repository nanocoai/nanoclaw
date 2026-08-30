\set ON_ERROR_STOP on

-- Run as the database owner after the migration step. Role and schema names
-- are the NanoClaw deployment defaults; recipes may render namespaced copies.
REVOKE CREATE ON SCHEMA nanoclaw FROM PUBLIC;
REVOKE ALL ON SCHEMA nanoclaw FROM nanoclaw_runtime;
GRANT USAGE ON SCHEMA nanoclaw TO nanoclaw_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nanoclaw TO nanoclaw_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA nanoclaw
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nanoclaw_runtime;
