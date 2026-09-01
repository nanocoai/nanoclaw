import type { DbDriver } from '../db/driver.js';
import { registerMigration } from '../db/migrations/index.js';

export const HOST_AUDIT_MIGRATION_NAME = 'module:host-audit:outbox-v1' as const;

async function createHostAuditSchema(db: DbDriver): Promise<void> {
  if (db.dialect !== 'postgres') {
    throw new Error('Host audit requires the composed central PostgreSQL driver');
  }

  await db.exec(`
    CREATE TABLE host_audit_producer_state (
      host_id TEXT PRIMARY KEY,
      last_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0 AND last_seq <= 9007199254740991)
    );

    CREATE TABLE host_audit_events (
      host_id TEXT NOT NULL,
      seq BIGINT NOT NULL CHECK (seq >= 1 AND seq <= 9007199254740991),
      event_id TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (host_id, seq),
      FOREIGN KEY (host_id) REFERENCES host_audit_producer_state(host_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_host_audit_events_event_id ON host_audit_events(event_id);
    CREATE INDEX idx_host_audit_events_occurred_at ON host_audit_events(host_id, occurred_at, seq);

    CREATE TABLE host_audit_delivery_state (
      host_id TEXT PRIMARY KEY,
      acked_through_seq BIGINT NOT NULL DEFAULT 0
        CHECK (acked_through_seq >= 0 AND acked_through_seq <= 9007199254740991),
      pruned_through_seq BIGINT NOT NULL DEFAULT 0
        CHECK (pruned_through_seq >= 0 AND pruned_through_seq <= acked_through_seq),
      updated_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (host_id) REFERENCES host_audit_producer_state(host_id) ON DELETE RESTRICT
    );

    CREATE FUNCTION enforce_host_audit_producer_state() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'host audit producer state cannot be deleted';
      END IF;
      IF NEW.host_id <> OLD.host_id OR NEW.last_seq <> OLD.last_seq + 1 THEN
        RAISE EXCEPTION 'host audit producer sequence must advance by exactly one';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER host_audit_producer_state_guard
      BEFORE UPDATE OR DELETE ON host_audit_producer_state
      FOR EACH ROW EXECUTE FUNCTION enforce_host_audit_producer_state();

    CREATE FUNCTION enforce_host_audit_delivery_state() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      allocated BIGINT;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'host audit delivery state cannot be deleted';
      END IF;
      SELECT last_seq INTO allocated
        FROM host_audit_producer_state
       WHERE host_id = OLD.host_id;
      IF NEW.host_id <> OLD.host_id
         OR NEW.acked_through_seq < OLD.acked_through_seq
         OR NEW.pruned_through_seq < OLD.pruned_through_seq
         OR NEW.pruned_through_seq > NEW.acked_through_seq
         OR NEW.acked_through_seq > allocated THEN
        RAISE EXCEPTION 'invalid host audit delivery progress';
      END IF;
      IF NEW.pruned_through_seq > OLD.pruned_through_seq
         AND EXISTS (
           SELECT 1 FROM host_audit_events
            WHERE host_id = OLD.host_id
              AND seq > OLD.pruned_through_seq
              AND seq <= NEW.pruned_through_seq
         ) THEN
        RAISE EXCEPTION 'host audit prune progress cannot advance past retained rows';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER host_audit_delivery_state_guard
      BEFORE UPDATE OR DELETE ON host_audit_delivery_state
      FOR EACH ROW EXECUTE FUNCTION enforce_host_audit_delivery_state();

    CREATE FUNCTION enforce_host_audit_event_immutability() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      acknowledged BIGINT;
      prune_host TEXT;
      prune_through BIGINT;
      prune_before TIMESTAMPTZ;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'host audit event rows are immutable';
      END IF;
      prune_host := current_setting('nanoclaw.host_audit_prune_host', true);
      prune_through := NULLIF(current_setting('nanoclaw.host_audit_prune_through', true), '')::BIGINT;
      prune_before := NULLIF(current_setting('nanoclaw.host_audit_prune_before', true), '')::TIMESTAMPTZ;
      SELECT acked_through_seq INTO acknowledged
        FROM host_audit_delivery_state
       WHERE host_id = OLD.host_id;
      IF prune_host IS DISTINCT FROM OLD.host_id
         OR prune_through IS NULL
         OR prune_before IS NULL
         OR OLD.seq > prune_through
         OR OLD.seq > acknowledged
         OR OLD.occurred_at >= prune_before THEN
        RAISE EXCEPTION 'host audit event deletion is outside the acknowledged retention prefix';
      END IF;
      RETURN OLD;
    END;
    $$;

    CREATE TRIGGER host_audit_events_immutable
      BEFORE UPDATE OR DELETE ON host_audit_events
      FOR EACH ROW EXECUTE FUNCTION enforce_host_audit_event_immutability();

    CREATE FUNCTION advance_host_audit_prune_progress() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      deleted_host TEXT;
      deleted_hosts BIGINT;
      deleted_count BIGINT;
      first_deleted BIGINT;
      last_deleted BIGINT;
      prune_host TEXT;
      prune_through BIGINT;
      progress_time TIMESTAMPTZ;
      acknowledged BIGINT;
      previously_pruned BIGINT;
    BEGIN
      SELECT MIN(host_id), COUNT(DISTINCT host_id), COUNT(*), MIN(seq), MAX(seq)
        INTO deleted_host, deleted_hosts, deleted_count, first_deleted, last_deleted
        FROM deleted_host_audit_rows;
      IF deleted_count = 0 THEN RETURN NULL; END IF;

      prune_host := current_setting('nanoclaw.host_audit_prune_host', true);
      prune_through := NULLIF(current_setting('nanoclaw.host_audit_prune_through', true), '')::BIGINT;
      progress_time := NULLIF(current_setting('nanoclaw.host_audit_prune_updated_at', true), '')::TIMESTAMPTZ;
      SELECT acked_through_seq, pruned_through_seq
        INTO acknowledged, previously_pruned
        FROM host_audit_delivery_state
       WHERE host_id = deleted_host
       FOR UPDATE;
      IF deleted_hosts <> 1
         OR prune_host IS DISTINCT FROM deleted_host
         OR prune_through IS NULL
         OR progress_time IS NULL
         OR first_deleted <> previously_pruned + 1
         OR last_deleted <> prune_through
         OR deleted_count <> last_deleted - first_deleted + 1
         OR last_deleted > acknowledged THEN
        RAISE EXCEPTION 'host audit deletion must be one contiguous acknowledged prefix';
      END IF;

      UPDATE host_audit_delivery_state
         SET pruned_through_seq = last_deleted, updated_at = progress_time
       WHERE host_id = deleted_host;
      RETURN NULL;
    END;
    $$;

    CREATE TRIGGER host_audit_events_prune_progress
      AFTER DELETE ON host_audit_events
      REFERENCING OLD TABLE AS deleted_host_audit_rows
      FOR EACH STATEMENT EXECUTE FUNCTION advance_host_audit_prune_progress();
  `);
}

registerMigration({
  version: 1,
  name: HOST_AUDIT_MIGRATION_NAME,
  up: createHostAuditSchema,
});
