/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

const FAILED_TURN_KEY = 'failed_turn';

export interface FailedTurnRecord {
  /** The prompt that was sent to the provider on the failed turn. Used to
   *  reconstruct what the user asked when we replay context on the next
   *  turn — the inbound row has been markCompleted'd by then. */
  prompt: string;
  /** The error message we surfaced to the user. The next turn tells the
   *  agent about it so it can acknowledge the failure rather than acting
   *  as if the previous message never happened. */
  error: string;
  /** Wall-clock when we recorded the failure. Lets the next turn render a
   *  rough "a few seconds ago" hint if desired. */
  recorded_at: number;
}

/** Persist a failed-turn record. Called when a turn surfaces an error to
 *  the user (either via the unsurfacedError path or by throwing after
 *  stale-session retry is exhausted). Read once on the next turn so the
 *  agent has visibility into what was lost.
 *
 *  Pairs with the continuation rollback in processQuery: when we revert
 *  to the prior good session id, the resumed transcript has no record of
 *  the failed message or its error. This row carries that context across
 *  turns instead. */
export function setFailedTurn(record: FailedTurnRecord): void {
  setValue(FAILED_TURN_KEY, JSON.stringify(record));
}

export function getFailedTurn(): FailedTurnRecord | undefined {
  const raw = getValue(FAILED_TURN_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as FailedTurnRecord;
  } catch {
    return undefined;
  }
}

export function clearFailedTurn(): void {
  deleteValue(FAILED_TURN_KEY);
}
