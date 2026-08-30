/** PostgreSQL-authoritative Host audit event store and delivery progress. */
import type { DbDriver } from '../db/driver.js';
import { AUDIT_ENABLED, AUDIT_HOST_ID, AUDIT_RETENTION_HOURS } from './config.js';
import { HOST_AUDIT_SCHEMA_VERSION, type AuditEvent } from './types.js';

export interface StoredAuditEvent {
  event: AuditEvent;
  /** Exact canonical JSON committed in PostgreSQL. */
  line: string;
}

export interface AuditStore {
  initialize(): Promise<void>;
  append(build: (seq: number) => AuditEvent): Promise<StoredAuditEvent>;
  allocatedThrough(): Promise<number>;
  acknowledgedThrough(): Promise<number>;
  advanceAcknowledgement(seq: number): Promise<void>;
  readAfter(seq: number, limit: number): Promise<StoredAuditEvent[]>;
  readNewest(beforeSeq: number | null, limit: number): Promise<StoredAuditEvent[]>;
  pruneAcknowledgedBefore(cutoff: Date): Promise<number>;
}

interface StoredAuditRow {
  seq: number;
  event_id: string;
  event_json: string;
}

interface DeliveryStateRow {
  acked_through_seq: number;
  pruned_through_seq: number;
}

const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_PRUNE_BATCH_ITEMS = 512;

function safeSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Host audit ${label}`);
  return value;
}

function parseStoredAuditRow(row: StoredAuditRow, hostId: string): StoredAuditEvent {
  let event: AuditEvent;
  try {
    event = JSON.parse(row.event_json) as AuditEvent;
  } catch (error) {
    throw new Error(`malformed Host audit row at seq ${row.seq}`, { cause: error });
  }
  if (
    event.schema_version !== HOST_AUDIT_SCHEMA_VERSION ||
    event.host_id !== hostId ||
    event.seq !== row.seq ||
    event.event_id !== row.event_id
  ) {
    throw new Error(`mismatched Host audit row at seq ${row.seq}`);
  }
  return { event, line: row.event_json };
}

class CentralPostgresAuditStore implements AuditStore {
  constructor(
    private readonly db: DbDriver,
    private readonly hostId: string,
  ) {}

  async initialize(): Promise<void> {
    if (!(await this.db.hasTable('host_audit_events'))) {
      throw new Error(
        'Host audit PostgreSQL schema is missing; apply module-migrations-deploy and run the migration job',
      );
    }
    await this.ensureBoundHost();
  }

  async append(build: (seq: number) => AuditEvent): Promise<StoredAuditEvent> {
    return this.db.transaction(async () => {
      // Match the Gateway audit boundary explicitly. The event is considered
      // recorded only after PostgreSQL synchronously commits its WAL record.
      await this.db.run('SET LOCAL synchronous_commit = on');
      await this.ensureBoundHost();
      await this.db.run(
        `INSERT INTO host_audit_producer_state (host_id, last_seq)
         VALUES (?, 0)
         ON CONFLICT (host_id) DO NOTHING`,
        this.hostId,
      );
      await this.db.run(
        `INSERT INTO host_audit_delivery_state
           (host_id, acked_through_seq, pruned_through_seq, updated_at)
         VALUES (?, 0, 0, ?)
         ON CONFLICT (host_id) DO NOTHING`,
        this.hostId,
        new Date().toISOString(),
      );
      const allocated = await this.db.get<{ seq: number }>(
        `UPDATE host_audit_producer_state
            SET last_seq = last_seq + 1
          WHERE host_id = ?
            AND last_seq < 9007199254740991
        RETURNING last_seq AS seq`,
        this.hostId,
      );
      if (!allocated) throw new Error('Host audit sequence space is exhausted');

      const event = build(allocated.seq);
      if (event.host_id !== this.hostId || event.seq !== allocated.seq) {
        throw new Error('Host audit builder changed its allocated identity');
      }
      const line = JSON.stringify(event);
      await this.db.run(
        `INSERT INTO host_audit_events
           (host_id, seq, event_id, occurred_at, event_json)
         VALUES (?, ?, ?, ?, ?)`,
        event.host_id,
        event.seq,
        event.event_id,
        event.occurred_at,
        line,
      );
      return { event, line };
    });
  }

  async allocatedThrough(): Promise<number> {
    await this.ensureBoundHost();
    const row = await this.db.get<{ last_seq: number }>(
      'SELECT last_seq FROM host_audit_producer_state WHERE host_id = ?',
      this.hostId,
    );
    return row ? safeSequence(row.last_seq, 'producer sequence') : 0;
  }

  async acknowledgedThrough(): Promise<number> {
    await this.ensureBoundHost();
    const row = await this.db.get<{ acked_through_seq: number }>(
      'SELECT acked_through_seq FROM host_audit_delivery_state WHERE host_id = ?',
      this.hostId,
    );
    return row ? safeSequence(row.acked_through_seq, 'acknowledgement') : 0;
  }

  async advanceAcknowledgement(seq: number): Promise<void> {
    safeSequence(seq, 'acknowledgement');
    await this.db.transaction(async () => {
      await this.ensureBoundHost();
      const state = await this.lockDeliveryState();
      const current = safeSequence(state.acked_through_seq, 'acknowledgement');
      if (seq < current) throw new Error('Host audit acknowledgement cannot move backwards');
      if (seq === current) return;
      const rows = await this.db.all<StoredAuditRow>(
        `SELECT seq, event_id, event_json
           FROM host_audit_events
          WHERE host_id = ? AND seq > ? AND seq <= ?
          ORDER BY seq`,
        this.hostId,
        current,
        seq,
      );
      this.requireContiguous(rows, current + 1, seq);
      await this.db.run(
        `UPDATE host_audit_delivery_state
            SET acked_through_seq = ?, updated_at = ?
          WHERE host_id = ?`,
        seq,
        new Date().toISOString(),
        this.hostId,
      );
    });
  }

  async readAfter(seq: number, limit: number): Promise<StoredAuditEvent[]> {
    safeSequence(seq, 'read cursor');
    this.requireReadLimit(limit);
    await this.ensureBoundHost();
    const rows = await this.db.all<StoredAuditRow>(
      `SELECT seq, event_id, event_json
         FROM host_audit_events
        WHERE host_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
      this.hostId,
      seq,
      limit,
    );
    return rows.map((row) => parseStoredAuditRow(row, this.hostId));
  }

  async readNewest(beforeSeq: number | null, limit: number): Promise<StoredAuditEvent[]> {
    if (beforeSeq !== null) safeSequence(beforeSeq, 'newest read cursor');
    this.requireReadLimit(limit);
    await this.ensureBoundHost();
    const rows = beforeSeq === null
      ? await this.db.all<StoredAuditRow>(
          `SELECT seq, event_id, event_json
             FROM host_audit_events
            WHERE host_id = ?
            ORDER BY seq DESC
            LIMIT ?`,
          this.hostId,
          limit,
        )
      : await this.db.all<StoredAuditRow>(
          `SELECT seq, event_id, event_json
             FROM host_audit_events
            WHERE host_id = ? AND seq < ?
            ORDER BY seq DESC
            LIMIT ?`,
          this.hostId,
          beforeSeq,
          limit,
        );
    return rows.map((row) => parseStoredAuditRow(row, this.hostId));
  }

  async pruneAcknowledgedBefore(cutoff: Date): Promise<number> {
    const cutoffMs = cutoff.getTime();
    if (!Number.isFinite(cutoffMs)) throw new Error('invalid Host audit retention cutoff');
    return this.db.transaction(async () => {
      await this.ensureBoundHost();
      const state = await this.lockDeliveryState();
      const acknowledged = safeSequence(state.acked_through_seq, 'acknowledgement');
      const pruned = safeSequence(state.pruned_through_seq, 'prune cursor');
      if (acknowledged <= pruned) return 0;
      const rows = await this.db.all<StoredAuditRow>(
        `SELECT seq, event_id, event_json
           FROM host_audit_events
          WHERE host_id = ? AND seq > ? AND seq <= ?
          ORDER BY seq
          LIMIT ?`,
        this.hostId,
        pruned,
        acknowledged,
        AUDIT_PRUNE_BATCH_ITEMS,
      );
      if (rows.length === 0) {
        throw new Error(`Host audit evidence gap at seq ${pruned + 1}`);
      }
      this.requireContiguous(rows, pruned + 1, rows[rows.length - 1].seq);

      let safeThrough = pruned;
      for (const row of rows) {
        const { event } = parseStoredAuditRow(row, this.hostId);
        const occurredAt = Date.parse(event.occurred_at);
        if (!Number.isFinite(occurredAt)) {
          throw new Error(`malformed Host audit occurrence time at seq ${row.seq}`);
        }
        if (occurredAt >= cutoffMs) break;
        safeThrough = row.seq;
      }
      if (safeThrough === pruned) return 0;

      await this.db.get(`SELECT set_config('nanoclaw.host_audit_prune_host', ?, true)`, this.hostId);
      await this.db.get(
        `SELECT set_config('nanoclaw.host_audit_prune_through', ?, true)`,
        String(safeThrough),
      );
      await this.db.get(
        `SELECT set_config('nanoclaw.host_audit_prune_before', ?, true)`,
        cutoff.toISOString(),
      );
      await this.db.get(
        `SELECT set_config('nanoclaw.host_audit_prune_updated_at', ?, true)`,
        new Date().toISOString(),
      );
      const result = await this.db.run(
        `DELETE FROM host_audit_events
          WHERE host_id = ? AND seq > ? AND seq <= ?`,
        this.hostId,
        pruned,
        safeThrough,
      );
      return result.changes;
    });
  }

  private async lockDeliveryState(): Promise<DeliveryStateRow> {
    await this.db.run(
      `INSERT INTO host_audit_delivery_state
         (host_id, acked_through_seq, pruned_through_seq, updated_at)
       VALUES (?, 0, 0, ?)
       ON CONFLICT (host_id) DO NOTHING`,
      this.hostId,
      new Date().toISOString(),
    );
    const state = await this.db.get<DeliveryStateRow>(
      `SELECT acked_through_seq, pruned_through_seq
         FROM host_audit_delivery_state
        WHERE host_id = ?
        FOR UPDATE`,
      this.hostId,
    );
    if (!state) throw new Error('Host audit delivery state is unavailable');
    return state;
  }

  private async ensureBoundHost(): Promise<void> {
    const foreign = await this.db.get<{ host_id: string }>(
      `SELECT host_id FROM host_audit_producer_state WHERE host_id <> ? LIMIT 1`,
      this.hostId,
    );
    if (foreign) throw new Error('Host audit database is already bound to a different deployment');
  }

  private requireContiguous(rows: StoredAuditRow[], first: number, last: number): void {
    if (rows.length !== last - first + 1) {
      throw new Error(`Host audit evidence gap in contiguous range ${first}-${last}`);
    }
    let expected = first;
    for (const row of rows) {
      if (row.seq !== expected) throw new Error(`Host audit evidence gap at seq ${expected}`);
      parseStoredAuditRow(row, this.hostId);
      expected++;
    }
  }

  private requireReadLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('invalid Host audit read limit');
    }
  }
}

let configuredStore: AuditStore | null = null;

export function createAuditStore(db: DbDriver, hostId: string): AuditStore {
  if (db.dialect !== 'postgres') {
    throw new Error('Host audit requires the composed central PostgreSQL driver');
  }
  if (!HOST_ID_RE.test(hostId)) throw new Error('Host audit requires a valid NANOCO_DEPLOYMENT_ID');
  return new CentralPostgresAuditStore(db, hostId);
}

export async function initializeAuditStore(db: DbDriver): Promise<AuditStore> {
  const store = createAuditStore(db, AUDIT_HOST_ID);
  await store.initialize();
  configuredStore = store;
  return store;
}

export function getAuditStore(): AuditStore {
  if (!configuredStore) throw new Error('Host audit store is not initialized');
  return configuredStore;
}

export async function appendAuditEvent(build: (seq: number) => AuditEvent): Promise<StoredAuditEvent> {
  return getAuditStore().append(build);
}

const HOUR_MS = 60 * 60 * 1000;
let lastPruneHour: number | null = null;

export async function pruneAuditLog(
  retentionHours: number = AUDIT_RETENTION_HOURS,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  if (retentionHours <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionHours * HOUR_MS);
  let total = 0;
  for (;;) {
    const removed = await getAuditStore().pruneAcknowledgedBefore(cutoff);
    total += removed;
    if (removed < AUDIT_PRUNE_BATCH_ITEMS || !shouldContinue()) return total;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function pruneAuditLogIfDue(shouldContinue?: () => boolean): Promise<number> {
  if (!AUDIT_ENABLED || AUDIT_RETENTION_HOURS <= 0) return 0;
  const hour = Math.floor(Date.now() / HOUR_MS);
  if (lastPruneHour === hour) return 0;
  lastPruneHour = hour;
  try {
    return await pruneAuditLog(AUDIT_RETENTION_HOURS, shouldContinue);
  } catch (error) {
    lastPruneHour = null;
    throw error;
  }
}

export function resetAuditStoreForTest(): void {
  configuredStore = null;
  lastPruneHour = null;
}
