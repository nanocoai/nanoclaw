/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  /** Task-series join key, set on kind='task' rows by the host scheduler.
   *  Optional: inbound.db predating the column yields undefined (SELECT *). */
  series_id?: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Selection is two-phase so accumulated context can never crowd a wake row
 * out of the batch: all due trigger=1 rows come first (oldest-first, up to
 * `maxMessagesPerPrompt`), then remaining slots fill with the NEWEST due
 * trigger=0 rows. Without this, ≥cap accumulated context rows (e.g.
 * non-engaged group messages) newer than a due task row would push the task
 * itself out of the batch. The combined batch is returned in chronological
 * order (oldest first). Host's countDueMessages gates waking on trigger=1
 * separately (see src/db/session-db.ts).
 *
 * ORDER MATTERS: the processing_ack filter runs BEFORE the cap windowing.
 * Rows this container already claimed stay status='pending' in inbound.db
 * until the host sweep syncs the ack back (up to ~60s) — windowing first
 * would let a cap-sized batch of those claimed rows fill the window, the
 * ack filter would then empty it, and genuinely new rows beyond the window
 * would be invisible for the rest of the turn.
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const cap = getMaxMessagesPerPrompt();
    const hasOnWake = hasOnWakeColumn(inbound);
    const stmt = inbound.prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${hasOnWake ? 'AND (on_wake = 0 OR ?1 = 1)' : ''}
       ORDER BY seq ASC`,
    );
    const due = (hasOnWake ? stmt.all(isFirstPoll ? 1 : 0) : stmt.all()) as MessageInRow[];
    if (due.length === 0) return [];

    // Drop rows already acknowledged in outbound.db (claimed by this or a
    // previous container run) BEFORE windowing — see the doc comment above.
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );
    const unclaimed = due.filter((m) => !ackedIds.has(m.id));

    // Phase 1: wake-eligible rows, oldest-first — these always make the batch.
    const wakeRows = unclaimed.filter((m) => m.trigger === 1).slice(0, cap);
    // Phase 2: fill remaining slots with the NEWEST context-only rows.
    const remaining = cap - wakeRows.length;
    const contextRows = remaining > 0 ? unclaimed.filter((m) => m.trigger === 0).slice(-remaining) : [];

    // Merge oldest-first. JS sort is stable, so ties (null seq in tests)
    // keep wake rows ahead of context rows.
    return [...wakeRows, ...contextRows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id, new Date().toISOString());
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', ?)",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id, new Date().toISOString());
  })();
}

/**
 * Ack task messages whose pre-task script gated the run. The reason decides
 * the ack: `gated` (wakeAgent=false) is the monitor working as designed → a
 * plain `completed`; `error` (broken script) → `script-skip:error`, which the
 * host's ack sync records as a FAILED run so recurrence can read the trailing
 * failed streak off the occurrence rows and back the series off.
 */
export function markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  if (skips.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const s of skips) stmt.run(s.id, s.reason === 'error' ? 'script-skip:error' : 'completed', new Date().toISOString());
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', ?)",
    )
    .run(id, new Date().toISOString());
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}
