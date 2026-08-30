\set ON_ERROR_STOP on

-- Optional read-only role for test harnesses and operational inspection.
REVOKE ALL ON SCHEMA nanoclaw FROM harness_ro;
GRANT USAGE ON SCHEMA nanoclaw TO harness_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA nanoclaw TO harness_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA nanoclaw
  GRANT SELECT ON TABLES TO harness_ro;
