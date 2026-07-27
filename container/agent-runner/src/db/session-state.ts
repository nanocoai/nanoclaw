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

// ── Quota-degraded flag ─────────────────────────────────────────────────────
// Tracks whether the primary provider is currently quota-exhausted AND the
// user has already been told about it (either "switched to the backup engine"
// when a fallback is configured, or "quota is out, try later" when none is).
// Persisted here — not a module-level variable — so it survives container
// restarts: during a multi-hour outage the container may be killed and
// respawned repeatedly, and the degraded/recovered notices must fire exactly
// ONCE per outage, not once per message and not again after every restart.
const QUOTA_DEGRADED_KEY = 'quota_degraded';

/** True while the primary is quota-exhausted and the user has been notified. */
export function isQuotaDegraded(): boolean {
  return getValue(QUOTA_DEGRADED_KEY) === '1';
}

/** Mark (or clear) the quota-degraded state. */
export function setQuotaDegraded(degraded: boolean): void {
  if (degraded) setValue(QUOTA_DEGRADED_KEY, '1');
  else deleteValue(QUOTA_DEGRADED_KEY);
}

// ── Fallback-failure notice dedup ───────────────────────────────────────────
// Remembers that the user was already shown "❌ the backup engine failed too"
// during the current failure streak, so repeated fallback failures within one
// outage don't spam the notice on every message (observed live 2026-07-07/08:
// four ❌ banners across one outage). Cleared when a fallback turn succeeds
// or the primary recovers.
const FALLBACK_FAILURE_NOTIFIED_KEY = 'fallback_failure_notified';

/** True if the ❌ fallback-failed notice was already sent this streak. */
export function isFallbackFailureNotified(): boolean {
  return getValue(FALLBACK_FAILURE_NOTIFIED_KEY) === '1';
}

/** Mark (or clear) that the ❌ fallback-failed notice was sent. */
export function setFallbackFailureNotified(notified: boolean): void {
  if (notified) setValue(FALLBACK_FAILURE_NOTIFIED_KEY, '1');
  else deleteValue(FALLBACK_FAILURE_NOTIFIED_KEY);
}

// ── Approaching-quota warning dedup ─────────────────────────────────────────
// Remembers which plan window we've already sent the "you're near your quota"
// heads-up for, so the warning fires exactly ONCE per window. Keyed by the
// window's reset timestamp: when the window rolls over (new resetsAt), the key
// changes and the next approach re-arms the warning automatically.
const QUOTA_WARNED_KEY = 'quota_warned_window';

/** The window key we last warned the user about, or undefined if none. */
export function getQuotaWarnedWindow(): string | undefined {
  return getValue(QUOTA_WARNED_KEY);
}

/** Record that we've warned for this window key. */
export function setQuotaWarnedWindow(windowKey: string): void {
  setValue(QUOTA_WARNED_KEY, windowKey);
}

// ── Thread size tracking + last-turn provider ───────────────────────────────
// Providers whose native compaction does not shrink the on-disk rollout
// (codex: a thread reached ~370k tokens and wedged on every resume,
// 2026-07-22) persist their last-known cumulative input-token count here.
// The poll-loop rotates to a fresh thread before the count reaches
// wedge territory. `last_turn_provider` records which engine answered the
// most recent turn, so a manual or quota-driven engine switch (and a
// post-rotation fresh thread) gets a conversation recap prepended.

function threadTokensKey(providerName: string): string {
  return `thread_tokens:${providerName.toLowerCase()}`;
}

/** Last persisted cumulative input-token count for the provider's thread. */
export function getThreadTokens(providerName: string): number {
  const v = getValue(threadTokensKey(providerName));
  const n = v === undefined ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function setThreadTokens(providerName: string, tokens: number): void {
  setValue(threadTokensKey(providerName), String(Math.round(tokens)));
}

export function clearThreadTokens(providerName: string): void {
  deleteValue(threadTokensKey(providerName));
}

const LAST_TURN_PROVIDER_KEY = 'last_turn_provider';

/** Provider that answered the most recent successful turn, if known. */
export function getLastTurnProvider(): string | undefined {
  return getValue(LAST_TURN_PROVIDER_KEY);
}

export function setLastTurnProvider(providerName: string): void {
  setValue(LAST_TURN_PROVIDER_KEY, providerName.toLowerCase());
}

export function clearLastTurnProvider(): void {
  deleteValue(LAST_TURN_PROVIDER_KEY);
}

// ── Pre-task script result dedupe ───────────────────────────────────────────
// Remembers, per task series, the hash of the script data that last woke the
// agent, so a recurring watcher re-reporting identical data can't wake a full
// LLM turn again. Keyed per series (falls back to the task id for one-offs).
function taskResultHashKey(seriesKey: string): string {
  return `task_result_hash:${seriesKey}`;
}

export function getTaskResultHash(seriesKey: string): string | undefined {
  return getValue(taskResultHashKey(seriesKey));
}

export function setTaskResultHash(seriesKey: string, hash: string): void {
  setValue(taskResultHashKey(seriesKey), hash);
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
