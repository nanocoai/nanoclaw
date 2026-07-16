# 02 — Claude→Codex Quota Fallback

Source commits (local, on top of merge-base `e263352a`): `b3056507` (core fallback), `19fc14e1`, `84ea6294`, `f102c450` (persisted `quota_degraded` flag + self-heal), `6c6c0538`, `f789eb92` (only warn on `five_hour` window), `cf8cd8ee` (idle-based timeouts, in-turn fresh-thread retry, ❌ dedup), `3255cc2e` (cross-provider handoff recap), `256429c9` (idempotent messages-out), `7a468e92` (`--image-tag none` / `--fallback-provider none`).

## System-level behavioral contract

Per agent group, an optional **fallback provider** (in practice: Codex/OpenAI) can be configured. When the primary provider (Claude) hits a **genuine, durable quota exhaustion** — not a transient 429/529/overload — the unanswered prompt for that turn is retried once on the fallback provider, in the same container, same session DBs. Every new turn starts on the primary again, so recovery back to Claude is automatic. The state machine:

1. **Detection** — Claude's quota exhaustion arrives either as a thrown error (`usage limit reached|<epoch>`) or, confirmed live, as a *successful* result whose text is the bare session-limit banner. Both are classified by regex (`quota.ts`). Transient throttles never trip the fallback.
2. **Notify once per outage** — a persisted `quota_degraded` flag in `session_state` (outbound.db) ensures the "⚠️ switched to Codex" (or "⚠️ quota out, no fallback") notice fires exactly once per outage, surviving container restarts. When the primary later produces a real result while degraded, the flag clears and a "✅ back to Claude / quota renewed" notice fires once.
3. **Fallback turn** — resumes the fallback's *own* stored continuation (per-provider keys). If the stored thread wedges (the live failure mode: a resume that hangs), the thread is cleared and the SAME turn retried once fresh, in-turn. ❌ "backup failed too" is sent at most once per failure streak (`fallback_failure_notified` flag).
4. **Liveness** — a fallback turn is guarded by an **idle** timeout (180 s with no streamed events ⇒ wedged) plus a generous **absolute** cap (20 min), not a wall-clock deadline (a 150 s wall-clock deadline killed every heavy Codex turn live).
5. **Handoff recap** — each provider keeps a private thread, so on a switch (in either direction) a compact recap of the recent exchange, rebuilt from the session DBs, is prepended to the first prompt the incoming engine sees.
6. **Proactive warning** — Claude's `rate_limit_event` utilization updates are forwarded as `quota_status` events; the user gets one Hebrew heads-up per 5-hour plan window when utilization crosses 90 % (env-tunable).
7. **Idempotent outbound** — identical chat messages written twice within 60 s (MCP tool + `<message>` block + nudge re-send) collapse to one row.

User-facing notices are in **Hebrew** (this install's owner language) — port verbatim or translate deliberately.

**Dependency:** the fallback requires a `codex` provider registered on both sides (container `container/agent-runner/src/providers/codex.ts` + `codex-app-server.ts`, host `src/providers/codex.ts`). Container-side codex is installed via the `/add-codex` skill / `providers` branch and is covered by its own guide section; the *host-side* `src/providers/codex.ts` is included below because the fallback-merge depends on it.

---

## 1. `container/agent-runner/src/quota.ts` — NEW FILE (verbatim, in full)

**Intent:** single source of truth separating GENUINE quota exhaustion (may switch providers + notify) from TRANSIENT throttling (never switch, SDK retries). Conflating the two caused a production false-positive.

```ts
/**
 * Quota-exhaustion detection, shared by providers and the poll-loop's
 * fallback path.
 *
 * There are TWO distinct signal classes and conflating them was the source
 * of a production false-positive (2026-07-06): a transient 429 right after a
 * container restart was misread as usage-exhaustion and tripped the Codex
 * fallback while real usage was only ~63% of the session window.
 *
 *   GENUINE   — the subscription / credit is actually spent; the provider
 *               cannot serve another turn until it resets. This is the ONLY
 *               class that may trip the fallback and notify the user.
 *   TRANSIENT — the server is briefly throttling or overloaded (HTTP 429/529,
 *               "overloaded", "temporarily limiting requests"). The Claude
 *               SDK already retries these internally; we must NOT switch
 *               providers and must NOT notify.
 */

// Genuine, durable exhaustion. Anthropic subscription limits surface either
// as the literal "…usage limit reached|<resetEpoch>" error, or — confirmed
// live 2026-07-06 — as a *successful* result whose text is the session-limit
// banner ("You've hit your session limit · resets 7:30am (UTC)"). The credit
// / quota phrases cover the API-key billing case. None of these appear in an
// ordinary agent reply, and (critically) NOT a bare 429 / rate-limit / overload.
export const GENUINE_QUOTA_RE =
  /usage limit reached|hit your session limit|session limit[^\n]*reset|reached your usage limit|credit balance (is )?too low|insufficient credits|quota (exceeded|exhausted|has been used)/i;

// Transient throttling / overload — explicitly NOT a genuine exhaustion.
// Retried by the SDK; surfaced here only so callers can positively recognise
// a "wait and retry" condition versus a "switch providers" one.
export const TRANSIENT_LIMIT_RE =
  /\b429\b|\b529\b|rate.?limit|overloaded|temporarily (limiting|unavailable)|server (is )?(busy|overloaded)|please try again/i;

/**
 * True only for a genuine, durable usage/credit exhaustion — the sole
 * condition that may trip the Codex fallback + user notification.
 */
export function isGenuineQuotaError(message: string): boolean {
  return GENUINE_QUOTA_RE.test(message);
}

/**
 * True for a transient throttle/overload that is NOT a genuine exhaustion.
 * Genuine wording always wins, so a message that is both (e.g. a limit error
 * that happens to include "429") is treated as genuine, not transient.
 */
export function isTransientLimit(message: string): boolean {
  return !GENUINE_QUOTA_RE.test(message) && TRANSIENT_LIMIT_RE.test(message);
}

/**
 * Thrown by the poll-loop's event handling when the active provider reports
 * quota exhaustion mid-query. Carries the prompt segment that went
 * unanswered so the fallback provider can retry exactly that input.
 */
export class QuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly lastPrompt: string,
  ) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
```

---

## 2. `container/agent-runner/src/handoff.ts` — NEW FILE (verbatim, in full)

**Intent:** providers keep private transcripts; on an engine switch the incoming engine gets a `<system>` recap of the last ~12 messages rebuilt from `messages_in` (inbound.db) + `messages_out` (outbound.db) so the switch doesn't read as "a different person". Best-effort: any failure returns `''` and never blocks the turn. Notices this pipeline injects (prefix ⚠️/❌/✅) are filtered out.

```ts
/**
 * Cross-provider conversation handoff.
 *
 * Each provider keeps its own private conversation thread (Claude a .jsonl
 * transcript, Codex a rollout) — so when quota forces a Claude→Codex switch,
 * the incoming engine has never seen what was just discussed, and when Claude
 * recovers it never saw the Codex-era turns. To the user this reads as "two
 * different people" (reported live 2026-07-08).
 *
 * The session DBs are the provider-agnostic source of truth: every user
 * message is in inbound.db (`messages_in`) and every delivered agent reply is
 * in outbound.db (`messages_out`), regardless of which engine authored it.
 * This module builds a compact recap of the recent exchange from those two
 * tables, to be prepended to the first prompt an engine sees after a switch
 * (in either direction) so it can pick up mid-conversation.
 */
import { getInboundDb, getOutboundDb } from './db/connection.js';

function log(msg: string): void {
  console.error(`[handoff] ${msg}`);
}

/** Max messages included in a recap (both sides combined, newest kept). */
const RECAP_MAX_MESSAGES = 12;
/** Per-message truncation. */
const RECAP_MSG_MAX_CHARS = 400;
/** Whole-recap budget — keeps the prefix cheap even with long messages. */
const RECAP_TOTAL_MAX_CHARS = 4000;

// System notices this pipeline itself injects (quota/fallback banners). They
// are noise inside a recap — the incoming engine needs the conversation, not
// our plumbing chatter.
const NOTICE_PREFIX_RE = /^[⚠️❌✅]/u;

interface ExchangeEntry {
  role: 'User' | 'You';
  ts: string;
  text: string;
}

/**
 * Build a `<system>` handoff prefix summarizing the recent exchange, or ''
 * when there is nothing useful (empty session, unreadable DBs — recap is
 * best-effort and must never block the turn itself).
 *
 * Direction-neutral on purpose: the same prompt segment can travel primary →
 * fallback within one turn (quota discovered mid-attempt), so the wording has
 * to make sense to whichever engine ends up reading it.
 */
export function buildHandoffRecap(): string {
  try {
    const entries: ExchangeEntry[] = [];

    const inRows = getInboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(RECAP_MAX_MESSAGES) as Array<{ timestamp: string; content: string }>;
    for (const r of inRows) {
      const text = extractText(r.content);
      if (text) entries.push({ role: 'User', ts: r.timestamp, text });
    }

    const outRows = getOutboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat'
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(RECAP_MAX_MESSAGES) as Array<{ timestamp: string; content: string }>;
    for (const r of outRows) {
      const text = extractText(r.content);
      if (text && !NOTICE_PREFIX_RE.test(text)) entries.push({ role: 'You', ts: r.timestamp, text });
    }

    if (entries.length === 0) return '';

    // Chronological, newest RECAP_MAX_MESSAGES across both sides.
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    const recent = entries.slice(-RECAP_MAX_MESSAGES);

    const lines: string[] = [];
    let budget = RECAP_TOTAL_MAX_CHARS;
    // Walk newest-first so the budget preferentially keeps recent turns,
    // then restore chronological order for readability.
    for (const e of [...recent].reverse()) {
      const t = e.text.length > RECAP_MSG_MAX_CHARS ? `${e.text.slice(0, RECAP_MSG_MAX_CHARS)}…` : e.text;
      const line = `[${e.role}] ${t.replace(/\s+/g, ' ').trim()}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.push(line);
    }
    lines.reverse();

    return (
      `<system>Engine handoff: this ongoing conversation just switched between the primary and backup ` +
      `engines (quota event). You may not have seen the most recent turns — they are recapped below, oldest ` +
      `first. Continue seamlessly as the same assistant: do not re-introduce yourself, do not mention the ` +
      `engine switch, and do not ask the user to resend anything they already provided.\n` +
      `Recent exchange:\n${lines.join('\n')}</system>\n\n`
    );
  } catch (err) {
    log(`recap failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

function extractText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}
```

**Integration note:** upstream added a provider-agnostic memory system — verify the `messages_in.kind` values (`'chat'`, `'chat-sdk'`) and `messages_out.kind='chat'` still match upstream's schema before porting; adjust the WHERE clauses if kinds were renamed.

---

## 3. `container/agent-runner/src/db/session-state.ts` — per-provider continuations + three persisted flags

**Intent:** (a) continuation ids keyed **per provider** (`continuation:<name>`) so switching providers is lossless, with a one-time migration of the legacy single-key `sdk_session_id`; (b) three persisted flags that make notices fire once per outage/streak/window even across container restarts: `quota_degraded`, `fallback_failure_notified`, `quota_warned_window`.

Upstream may already have some continuation persistence in this file (or have moved it in the memory rework). Reapply by ensuring the file exposes exactly this API; local full contents:

```ts
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

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}
```

---

## 4. Provider event surface — `providers/types.ts` + `providers/claude.ts`

### 4a. `container/agent-runner/src/providers/types.ts` — add `quota_status` to `ProviderEvent`

Add this variant to the `ProviderEvent` union (alongside `result`/`error`/`progress`):

```ts
  /**
   * Plan quota-utilization update for the active subscription window. Emitted
   * by providers that expose it (Claude via `rate_limit_event`) so the
   * poll-loop can warn the user once as they approach exhaustion. Purely
   * informational — never gates a turn.
   */
  | {
      type: 'quota_status';
      /** Percentage of the active plan window used, 0-100 (undefined if unknown). */
      utilization?: number;
      /** True when the SDK itself flagged the window as approaching its limit. */
      warning?: boolean;
      /** Epoch ms when the active window resets — de-dup key so we warn once per window. */
      resetsAt?: number | null;
      /** Which plan window this refers to (e.g. 'five_hour', 'seven_day'). */
      window?: string;
    }
```

### 4b. `container/agent-runner/src/providers/claude.ts` — quota detection in the SDK message loop

Add `import { isGenuineQuotaError } from '../quota.js';` at the top.

**(i)** Where the SDK `message.type === 'result'` was previously `yield { type: 'result', text }`, replace with:

```ts
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          // A genuine subscription limit comes back as a *successful* result
          // whose text IS the bare limit banner ("You've hit your session
          // limit · resets 7:30am (UTC)") — not flagged is_error at all, so
          // we must inspect the text. But an ordinary agent reply is ALWAYS
          // wrapped in <message to="…"> blocks; a bare banner never is (the
          // agent never got to author anything). Requiring the absence of a
          // wrapper stops the agent's own reply — e.g. one that discusses the
          // quota-fallback feature and mentions "usage limit" — from being
          // misread as a quota error and dumped raw to the user (2026-07-06).
          const isAuthoredReply = /<message\s+to="/i.test(text ?? '');
          if (text && !isAuthoredReply && isGenuineQuotaError(text)) {
            yield { type: 'error', message: text, retryable: false, classification: 'quota' };
          } else {
            yield { type: 'result', text };
          }
```

**(ii)** Replace the old handling of `message.type === 'system' && subtype === 'rate_limit_event'` (which yielded a quota error unconditionally — a bug) with a **top-level** `rate_limit_event` branch:

```ts
        } else if (message.type === 'rate_limit_event') {
          // `rate_limit_event` is a TOP-LEVEL SDK message (not a system
          // subtype) carrying `rate_limit_info` for claude.ai subscription
          // users. Only `rejected` means the request was actually blocked —
          // treating informational statuses (allowed/allowed_warning) as quota
          // would trip the fallback on healthy turns. Everything else is an
          // informational utilization update we forward as `quota_status` so
          // the poll-loop can warn the user once as they approach the limit.
          const info = (message as {
            rate_limit_info?: { status?: string; utilization?: number; resetsAt?: number; rateLimitType?: string };
          }).rate_limit_info;
          const status = info?.status;
          if (status === 'rejected') {
            yield { type: 'error', message: 'Rate limit exceeded', retryable: false, classification: 'quota' };
          } else {
            yield {
              type: 'quota_status',
              utilization: info?.utilization,
              warning: status === 'allowed_warning',
              resetsAt: info?.resetsAt ?? null,
              window: info?.rateLimitType,
            };
          }
```

Also register codex in `container/agent-runner/src/providers/index.ts` (after installing the codex provider): add `import './codex.js';`.

---

## 5. `container/agent-runner/src/poll-loop.ts` — integration spec (semantic insertion points)

Upstream restructured this file ("one-door delivery"), so apply by **stage of the turn loop**, not by line. The turn loop's stages are: (A) collect pending batch → (B) format prompt → (C) run query streaming provider events → (D) on error → (E) finalize. All code below is verbatim from the local file.

### 5.1 Imports

```ts
import { writeMessageOut, getMaxOutSeq, countChatSendsSince } from './db/messages-out.js';
import {
  clearContinuation,
  getContinuation,
  getQuotaWarnedWindow,
  isFallbackFailureNotified,
  isQuotaDegraded,
  migrateLegacyContinuation,
  setContinuation,
  setFallbackFailureNotified,
  setQuotaDegraded,
  setQuotaWarnedWindow,
} from './db/session-state.js';
import { QuotaExhaustedError, isGenuineQuotaError, isTransientLimit } from './quota.js';
import { buildHandoffRecap } from './handoff.js';
```

### 5.2 Config extension — add to `PollLoopConfig`

```ts
  /**
   * Optional overflow provider. When the primary provider fails a turn with
   * a quota-exhaustion error, the unanswered prompt is retried once on this
   * provider and the user is notified of the switch. Every new turn starts
   * on the primary again, so recovery back to the primary is automatic.
   */
  fallback?: {
    provider: AgentProvider;
    providerName: string;
  };
```

### 5.3 Module-level constants/helpers (top of file, after the config interface)

```ts
// User-facing notices for the fallback flow. Sent to the same destination
// the failed turn was routed to.
const FALLBACK_SWITCH_NOTICE =
  '⚠️ מכסת Claude נגמרה כרגע — ממשיך לענות דרך Codex (OpenAI). אחזור ל-Claude אוטומטית כשהמכסה תתחדש.';
const FALLBACK_RETURN_NOTICE = '✅ מכסת Claude התחדשה — חזרתי לענות דרך Claude.';
const FALLBACK_FAILED_NOTICE = '❌ גם מנוע הגיבוי (Codex) לא הצליח לענות כרגע. נסו שוב מאוחר יותר.';
// Genuine quota exhaustion when NO fallback provider is configured. Shown
// once (deduped via the quota-degraded flag) instead of dumping the raw
// English "You've hit your session limit" banner on every message.
const NO_FALLBACK_QUOTA_NOTICE =
  '⚠️ מכסת Claude נגמרה כרגע. אנסה שוב אוטומטית כשהמכסה תתחדש — נסו שוב מאוחר יותר.';
// Sent once when the primary recovers and no fallback was involved (mirror of
// FALLBACK_RETURN_NOTICE for the no-fallback path).
const QUOTA_RENEWED_NOTICE = '✅ מכסת Claude התחדשה — חזרתי לפעול כרגיל.';

// Proactive heads-up sent ONCE per plan window when usage crosses the warning
// threshold, BEFORE the quota actually runs out. Deduped per window via
// get/setQuotaWarnedWindow. Threshold is operator-tunable via env.
function quotaWarnThresholdPct(): number {
  const v = Number(process.env.QUOTA_WARN_THRESHOLD_PCT);
  return Number.isFinite(v) && v > 0 && v < 100 ? v : 90;
}
function nearQuotaNotice(pctText: string, hasFallback: boolean): string {
  return hasFallback
    ? `⚠️ הגעת ל-${pctText} ממכסת Claude. כשהיא תיגמר אעבור אוטומטית לענות דרך Codex (OpenAI) — שתדע.`
    : `⚠️ הגעת ל-${pctText} ממכסת Claude. כשהיא תיגמר לא אוכל לענות עד שהמכסה תתחדש.`;
}
// Shown when the primary throws a *transient* throttle (429/overload) that
// the SDK gave up retrying. This is NOT quota exhaustion — do not switch
// providers, just tell the user to retry shortly.
const TRANSIENT_BUSY_NOTICE = '⚠️ השרת עמוס כרגע (הגבלת קצב זמנית) — נסו שוב עוד רגע.';

// Timeout model for a fallback turn — two distinct guards, because "hung" and
// "working hard" must be told apart by ACTIVITY, not wall-clock time:
//
//   IDLE timeout   — trips only after a long stretch with NO streamed events.
//                    A wedged thread-resume emits nothing and trips this fast;
//                    a real work turn (editing a file, running tools) streams
//                    notifications constantly and never trips it.
//   ABSOLUTE cap   — generous backstop against a pathological event-emitting
//                    loop. Kept under the host's 30-min heartbeat ceiling.
//
// Lesson learned live (2026-07-07): the original 150s WALL-CLOCK deadline
// killed every heavy Codex turn mid-work (CV editing, file reading) while
// light chat replies squeaked through — the user saw "❌ backup engine
// failed" on precisely the messages that mattered.
// Both read at call time so tests can drive the timeout paths.
function fallbackIdleTimeoutMs(): number {
  return Number(process.env.FALLBACK_IDLE_TIMEOUT_MS) || 180_000;
}
function fallbackTurnDeadlineMs(): number {
  return Number(process.env.FALLBACK_TURN_DEADLINE_MS) || 1_200_000;
}
```

### 5.4 Stage B — after formatting the batch prompt, before starting the query (reverse handoff)

```ts
    // Reverse handoff: while quota-degraded, recent turns were answered by
    // the fallback engine — the primary's own transcript never saw them. If
    // this attempt succeeds (quota recovered), the recap lets the primary
    // continue the conversation instead of resuming from a hole; if quota is
    // still out, the prompt flows to the fallback with the recap attached,
    // which is equally useful there (the recap wording is direction-neutral).
    if (isQuotaDegraded()) {
      prompt = buildHandoffRecap() + prompt;
    }
```

(Requires `prompt` to be a `let`.)

### 5.5 Stage C — inside the query-event processing function (locally `processQuery`)

Give it two extra inputs: `initialPrompt: string` (the formatted batch prompt) and `hasFallback: boolean`. Add per-query state:

```ts
  // Most recent user-content prompt segment sent into the query (initial
  // batch or follow-up push — not system nudges). On quota exhaustion this
  // is the segment that went unanswered, handed to the fallback provider.
  let lastPrompt = initialPrompt;
  // Seq snapshot at the start of the current prompt segment. If the agent
  // sends anything via MCP tools during the segment (send_message,
  // send_file, ...), countChatSendsSince(promptSeqMark) > 0 and an
  // unwrapped final text is just scratchpad — nudging the agent to
  // "re-send" would produce a duplicate reply, not a missing one.
  let promptSeqMark = getMaxOutSeq();
```

**Where a follow-up prompt is pushed into the active query** (concurrent-polling path), add before `query.push(prompt)`:

```ts
        promptSeqMark = getMaxOutSeq();
        lastPrompt = prompt;
```

**In the provider-event switch**, add two branches (before the `result` branch):

```ts
      } else if (event.type === 'error' && event.classification === 'quota') {
        // Provider is out of quota — this query cannot answer the current
        // segment. Abort and surface to runPollLoop, which retries the
        // segment on the fallback provider (when one is configured).
        query.abort();
        throw new QuotaExhaustedError(event.message, lastPrompt);
      } else if (event.type === 'quota_status') {
        // Informational plan-usage update. Warn the user ONCE per window when
        // they cross the threshold, before the quota actually runs out.
        maybeWarnApproachingQuota(event, routing, hasFallback);
      }
```

**In the `result` branch**, right after marking the initial batch completed and before dispatching `event.text`:

```ts
        // The session was quota-degraded and the primary just produced a real
        // result — quota recovered. Clear the flag and tell the user once,
        // with the message that matches how they were notified going in
        // (fallback → "back to Claude"; no fallback → "quota renewed").
        // Persisted, so this fires even if the container restarted mid-outage.
        // (Quota exhaustion never reaches this branch: claude.ts emits it as
        // an `error`/quota event, which processQuery rethrows as
        // QuotaExhaustedError before we get here.)
        if (isQuotaDegraded()) {
          setQuotaDegraded(false);
          setFallbackFailureNotified(false);
          writeNotice(routing, hasFallback ? FALLBACK_RETURN_NOTICE : QUOTA_RENEWED_NOTICE);
        }
```

**Nudge suppression** — where the "output was not wrapped" nudge is decided, change the condition from `hasUnwrapped && !unwrappedNudged` to:

```ts
          // Only nudge when the turn produced NO delivery at all. If the
          // agent already sent messages via MCP tools this segment, the
          // bare final text is a summary/scratchpad — nudging would make
          // the agent re-send and the user would get duplicates.
          const alreadySentThisTurn = countChatSendsSince(promptSeqMark) > 0;
          if (hasUnwrapped && !alreadySentThisTurn && !unwrappedNudged) {
```

Also add a `quota_status` case to the generic event logger if one exists:

```ts
    case 'quota_status':
      log(
        `Quota status: ${event.utilization !== undefined ? `${Math.round(event.utilization)}%` : 'n/a'}` +
          `${event.warning ? ' (warning)' : ''}${event.window ? ` [${event.window}]` : ''}`,
      );
      break;
```

### 5.6 Stage D — the catch block around the query call (the fallback state machine)

Where the turn's error is caught (`errMsg` extracted), replace the plain "clear stale continuation + write Error to user" logic with:

```ts
      // Quota exhaustion on the primary → retry the unanswered prompt on the
      // fallback provider. QuotaExhaustedError carries the exact prompt
      // segment that went unanswered; a plain thrown error that reads like a
      // GENUINE usage-limit (SDK subprocess died on a usage-limit response)
      // retries the batch's initial prompt. A transient 429/overload is
      // explicitly excluded here — it must NOT switch providers.
      const quotaPrompt =
        err instanceof QuotaExhaustedError ? err.lastPrompt : isGenuineQuotaError(errMsg) ? prompt : null;

      if (quotaPrompt !== null && config.fallback) {
        // Announce the switch to the user only on the TRANSITION into fallback
        // mode. During a multi-hour outage the primary is exhausted on every
        // turn, so an unconditional notice here spammed the user with the same
        // "switched to Codex" banner after every single message (observed live
        // 2026-07-06). The persisted flag makes it fire exactly once per
        // outage; the matching return notice fires once when the primary
        // recovers (see the result path in processQuery).
        const isFirstFallbackOfOutage = !isQuotaDegraded();
        if (isFirstFallbackOfOutage) {
          log(`Primary quota exhausted — switching to fallback provider '${config.fallback.providerName}'`);
          writeNotice(routing, FALLBACK_SWITCH_NOTICE);
          setQuotaDegraded(true);
        } else {
          log(
            `Primary still quota-exhausted — continuing on fallback '${config.fallback.providerName}' (notice suppressed)`,
          );
        }
        // Conversation handoff: the fallback engine has its own private
        // thread and never saw the primary-era turns. On the first fallback
        // turn of an outage — or whenever the fallback thread is fresh (none
        // stored, e.g. after a self-heal wipe) — prepend a recap of the
        // recent exchange so the switch doesn't read as "a different person
        // who remembers nothing" (reported live 2026-07-08). Mid-outage turns
        // resume the fallback's own thread, which already saw them.
        const fallbackHasThread = getContinuation(config.fallback.providerName) !== undefined;
        const fbPrompt =
          isFirstFallbackOfOutage || !fallbackHasThread ? buildHandoffRecap() + quotaPrompt : quotaPrompt;
        try {
          await runFallbackTurn(config.fallback, fbPrompt, routing, config.cwd, config.systemContext);
          // A fallback turn just answered — end any ❌-notice streak so a
          // future failure is announced again.
          setFallbackFailureNotified(false);
        } catch (fbErr) {
          const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
          log(`Fallback turn failed (after fresh-thread retry): ${fbMsg}`);
          // Backstop self-heal: runFallbackTurn already retried once on a
          // fresh thread; make sure no poisoned continuation survives into
          // the next turn either (skip when it's the fallback's own quota —
          // the thread is fine, just out of budget).
          if (!/quota exhausted/i.test(fbMsg)) {
            clearContinuation(config.fallback.providerName);
          }
          // Tell the user ONCE per failure streak — repeated failures during
          // one outage were spamming a ❌ banner on every message.
          if (!isFallbackFailureNotified()) {
            setFallbackFailureNotified(true);
            writeNotice(routing, FALLBACK_FAILED_NOTICE);
          } else {
            log('Fallback failed again — ❌ notice suppressed (already sent this streak)');
          }
        }
      } else {
        // Stale/corrupt continuation recovery: ask the provider whether
        // this error means the stored continuation is unusable, and clear
        // it so the next attempt starts fresh.
        if (continuation && config.provider.isSessionInvalid(err)) {
          log(`Stale session detected (${continuation}) — clearing for next retry`);
          continuation = undefined;
          clearContinuation(config.providerName);
        }

        // Genuine quota exhaustion but no fallback provider configured
        // (quotaPrompt was set yet config.fallback is undefined). Show a
        // friendly Hebrew notice ONCE — deduped via the same quota-degraded
        // flag — instead of dumping the raw English "session limit" banner on
        // every message for the whole outage (observed live 2026-07-06).
        if (quotaPrompt !== null && !config.fallback) {
          if (!isQuotaDegraded()) {
            log('Primary quota exhausted, no fallback configured — notifying user once');
            writeNotice(routing, NO_FALLBACK_QUOTA_NOTICE);
            setQuotaDegraded(true);
          } else {
            log('Primary still quota-exhausted, no fallback — notice suppressed');
          }
        } else {
          // Write error response so the user knows something went wrong. A
          // transient throttle (429/overload the SDK exhausted its retries on)
          // gets a friendly "try again" notice rather than a raw error dump —
          // it is NOT a provider-switch condition.
          const userText = isTransientLimit(errMsg) ? TRANSIENT_BUSY_NOTICE : `Error: ${errMsg}`;
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: userText }),
          });
        }
      }
```

### 5.7 New top-level functions (append near the bottom of poll-loop.ts)

```ts
/**
 * Send the proactive "approaching quota" heads-up at most once per plan
 * window. Fires when reported utilization crosses the configured threshold
 * (default 90%) or the SDK itself flags the window as warning. The window's
 * reset timestamp is the de-dup key, so a fresh window re-arms the warning.
 *
 * Exported for tests.
 */
export function maybeWarnApproachingQuota(
  event: { utilization?: number; warning?: boolean; resetsAt?: number | null; window?: string },
  routing: RoutingContext,
  hasFallback: boolean,
): void {
  // Only the 5-hour SESSION window maps to the "about to run out and switch to
  // Codex" experience — it's the window whose exhaustion produces "You've hit
  // your session limit". The 7-day / per-model weekly windows are a slower,
  // separate budget; warning on them produced confusing false alarms (observed
  // live: a longer window at 95% firing while the session window was nearly
  // empty, so the user was genuinely far from the limit that matters).
  if (event.window !== 'five_hour') return;

  const threshold = quotaWarnThresholdPct();
  // Utilization is a straight 0-100 percentage (confirmed live: a 1% window
  // reports `1`). Do NOT rescale — an earlier 0-1 "fraction guard" turned a
  // genuine `1` (1%) into 100% and false-alarmed.
  const pct = event.utilization;

  // Require a real utilization reading at/over the threshold. The SDK's
  // `allowed_warning` status is NOT a trigger on its own — observed firing on
  // the seven_day window at 1% utilization, which would spam a bogus warning.
  if (pct === undefined || pct < threshold) return;

  // One warning per window: key on the reset timestamp so the key naturally
  // changes each new session window and re-arms the warning.
  const windowKey = event.resetsAt != null ? `r:${event.resetsAt}` : 'five_hour';
  if (getQuotaWarnedWindow() === windowKey) return;
  setQuotaWarnedWindow(windowKey);

  const pctText = `${Math.round(pct)}%`;
  log(`Approaching quota (${pctText}, five_hour window ${windowKey}) — sending one-time heads-up`);
  writeNotice(routing, nearQuotaNotice(pctText, hasFallback));
}

/** Write a short system notice to the turn's origin destination. */
function writeNotice(routing: RoutingContext, text: string): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Run a single turn on the fallback provider: retry the unanswered prompt,
 * dispatch the result, persist the fallback's own continuation (kept in its
 * own per-provider slot so the fallback conversation also has memory), and
 * close the query so the outer loop returns to the primary provider on the
 * next batch.
 *
 * Resilience: the first attempt resumes the stored fallback thread (so the
 * fallback conversation keeps its memory). If that attempt fails for any
 * reason other than the fallback's own quota, the stored thread is presumed
 * poisoned (the live failure mode: a resume that wedges) — it is cleared and
 * the SAME turn is retried once on a fresh thread before giving up. The user
 * only sees ❌ if the fresh attempt also fails.
 *
 * Exported for tests.
 */
export async function runFallbackTurn(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext?: { instructions?: string },
): Promise<void> {
  const stored = getContinuation(fallback.providerName);
  try {
    await fallbackAttempt(fallback, prompt, routing, cwd, systemContext, stored);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Quota on the fallback itself: retrying won't help, and the thread is
    // fine — keep its memory for when credit returns.
    if (stored === undefined || /quota exhausted/i.test(msg)) throw err;
    log(`Fallback attempt on stored thread failed (${msg}) — clearing thread, retrying once fresh`);
    clearContinuation(fallback.providerName);
    await fallbackAttempt(fallback, prompt, routing, cwd, systemContext, undefined);
  }
}

/** One fallback attempt against a specific continuation (or a fresh thread). */
async function fallbackAttempt(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext: { instructions?: string } | undefined,
  continuation: string | undefined,
): Promise<void> {
  const promptSeqMark = getMaxOutSeq();
  const query = fallback.provider.query({ prompt, continuation, cwd, systemContext });

  let nudged = false;
  let gotResult = false;
  // Liveness guards (see the comment block at the timeout functions above):
  // idle timer trips on prolonged SILENCE — the signature of a wedged
  // resume/init — while a genuinely working turn streams events and stays
  // alive. The absolute cap is a generous backstop. abort() tears down the
  // provider process, so a stuck await rejects immediately and the primary
  // path recovers on the next turn instead of the whole poll-loop freezing.
  let timedOut: string | null = null;
  const idleMs = fallbackIdleTimeoutMs();
  const capMs = fallbackTurnDeadlineMs();
  let lastEventAt = Date.now();
  const idleTimer = setInterval(
    () => {
      if (Date.now() - lastEventAt >= idleMs) {
        timedOut = `no events for ${idleMs}ms`;
        log(`Fallback turn stalled (${timedOut}) — aborting`);
        query.abort();
      }
    },
    Math.min(Math.max(idleMs / 4, 50), 5_000),
  );
  const capTimer = setTimeout(() => {
    timedOut = `exceeded ${capMs}ms deadline`;
    log(`Fallback turn ${timedOut} — aborting`);
    query.abort();
  }, capMs);
  try {
    for await (const event of query.events) {
      lastEventAt = Date.now();
      touchHeartbeat();
      if (event.type === 'init') {
        setContinuation(fallback.providerName, event.continuation);
      } else if (event.type === 'error' && event.classification === 'quota') {
        query.abort();
        throw new Error(`Fallback provider quota exhausted: ${event.message}`);
      } else if (event.type === 'result') {
        gotResult = true;
        if (event.text) {
          const { hasUnwrapped } = dispatchResultText(event.text, routing);
          const alreadySentThisTurn = countChatSendsSince(promptSeqMark) > 0;
          if (hasUnwrapped && !alreadySentThisTurn && !nudged) {
            // Same one-shot re-wrap nudge as the primary path — give the
            // fallback one chance to deliver, then close regardless.
            nudged = true;
            gotResult = false;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `Your destinations: ${names}. Please re-send your response with the correct wrapping.</system>`,
            );
            continue;
          }
        }
        // Turn answered — close the stream so control returns to the
        // primary provider for the next batch.
        query.end();
      }
    }
  } finally {
    clearInterval(idleTimer);
    clearTimeout(capTimer);
    if (!gotResult) query.abort();
  }
  if (timedOut) {
    throw new Error(`Fallback provider timed out: ${timedOut}`);
  }
  if (!gotResult) {
    throw new Error('Fallback provider produced no result');
  }
}
```

**Adaptation note for the "one-door delivery" rework:** the local code delivers via `dispatchResultText`/`writeMessageOut` directly. If upstream now funnels all delivery through a single door, route `writeNotice` and the fallback turn's result dispatch through that same door — the *behavioral* requirements are: notices go to the failed turn's origin routing; the fallback result uses the same wrapped-`<message>` dispatch + one-shot nudge semantics as the primary; and `markCompleted` semantics for the batch are unchanged (batch is completed on the primary's `result`; on the quota path the batch messages are still marked completed by the normal error/finally handling upstream uses — verify no message is left `processing` after a fallback turn).

---

## 6. Agent-runner wiring — `config.ts` and `index.ts`

`container/agent-runner/src/config.ts`: add to `RunnerConfig`:

```ts
  /** Overflow provider used when the primary fails a turn on quota (optional). */
  fallbackProvider?: string;
```

and in `loadConfig()`:

```ts
    fallbackProvider: (raw.fallbackProvider as string) || undefined,
```

`container/agent-runner/src/index.ts` — where the provider is created, hoist the options and build the optional fallback, then pass `fallback` into `runPollLoop`:

```ts
  const providerOptions = {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  };
  const provider = createProvider(providerName, providerOptions);

  // Optional quota-overflow provider. Model/effort are primary-provider
  // settings — the fallback uses its own defaults (e.g. CODEX_MODEL env).
  let fallback: { provider: ReturnType<typeof createProvider>; providerName: string } | undefined;
  const fallbackName = config.fallbackProvider?.toLowerCase() as ProviderName | undefined;
  if (fallbackName && fallbackName !== providerName) {
    try {
      fallback = {
        provider: createProvider(fallbackName, { ...providerOptions, model: undefined, effort: undefined }),
        providerName: fallbackName,
      };
      log(`Fallback provider enabled: ${fallbackName}`);
    } catch (err) {
      log(
        `Fallback provider '${fallbackName}' not available (${err instanceof Error ? err.message : String(err)}) — continuing without fallback`,
      );
    }
  }

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    fallback,
  });
```

---

## 7. Idempotent outbound guard (`256429c9`) — `container/agent-runner/src/db/messages-out.ts`

**Intent:** the same reply can reach `writeMessageOut` via three paths in one turn (send_message MCP tool, `<message>` block in final result text, re-send after the "not wrapped" nudge) — the user saw triple messages live. Guard: skip a `kind='chat'`, non-scheduled write when an identical `(platform_id, channel_type, content)` row exists within 60 s; return the existing row's seq so agent-facing ids stay stable.

Add above `writeMessageOut`:

```ts
/**
 * Idempotent-outbound guard. The same reply can reach writeMessageOut via
 * several paths in one turn: the send_message MCP tool (mid-turn), a
 * <message> block in the final result text (end-of-turn dispatch in
 * poll-loop), and a re-send after the "output was not wrapped" nudge.
 * Without a guard the user sees the same text 2–3 times.
 *
 * Scope is deliberately narrow: only immediate user-facing chat messages
 * (kind='chat', no deliver_after/recurrence — scheduled reminders may
 * legitimately repeat). A message is a duplicate when an identical
 * (platform_id, channel_type, content) row was written within the window.
 */
const DEDUP_WINDOW_SECONDS = 60;

function findRecentDuplicateSeq(msg: WriteMessageOut): number | null {
  if (msg.kind !== 'chat' || msg.deliver_after || msg.recurrence) return null;
  const row = getOutboundDb()
    .prepare(
      `SELECT seq FROM messages_out
       WHERE kind = 'chat'
         AND platform_id IS $pid AND channel_type IS $ct AND content = $content
         AND deliver_after IS NULL AND recurrence IS NULL
         AND timestamp >= datetime('now', '-${DEDUP_WINDOW_SECONDS} seconds')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get({
      $pid: msg.platform_id ?? null,
      $ct: msg.channel_type ?? null,
      $content: msg.content,
    }) as { seq: number } | undefined;
  return row?.seq ?? null;
}
```

and at the very top of `writeMessageOut`:

```ts
  const duplicateSeq = findRecentDuplicateSeq(msg);
  if (duplicateSeq != null) {
    console.error(
      `[messages-out] Skipping duplicate outbound chat message (seq #${duplicateSeq} already sent to ${msg.channel_type}:${msg.platform_id} within ${DEDUP_WINDOW_SECONDS}s)`,
    );
    return duplicateSeq;
  }
```

Also add the two helpers used by the nudge-suppression logic:

```ts
/**
 * Highest outbound seq right now (0 when empty). Poll-loop snapshots this at
 * prompt start and uses countChatSendsSince() to know whether the agent
 * already delivered something this turn (e.g. via the send_message MCP tool).
 */
export function getMaxOutSeq(): number {
  return (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
}

/** Count user-facing chat messages written after the given seq snapshot. */
export function countChatSendsSince(seq: number): number {
  return (
    getOutboundDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM messages_out
         WHERE seq > ? AND kind = 'chat' AND deliver_after IS NULL AND recurrence IS NULL`,
      )
      .get(seq) as { c: number }
  ).c;
}
```

(bun:sqlite note: named params keep the `$` prefix in JS keys.)

---

## 8. Host side — `fallback_provider` column and plumbing

### 8.1 Migration `src/db/migrations/017-fallback-provider.ts`

```ts
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'fallback-provider',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN fallback_provider TEXT').run();
  },
};
```

**Renumbering + reconciliation (IMPORTANT):** upstream `main` already occupies `017`/`018`. The migration system (`src/db/migrations/index.ts`, `runMigrations`) tracks applied migrations **by `name`, not by version**: it builds `Set(schema_version.name)` and skips any migration whose `name` is already present; the stored `version` column is just an auto-assigned applied-order counter (`MAX(version)+1`). The live DB records exactly the string `fallback-provider` (verified: row `15|fallback-provider` in `schema_version`; there is NO `017-` prefix stored).

So:
1. Copy the file to the next free number on the new base, e.g. `src/db/migrations/019-fallback-provider.ts`, rename the export (`migration019`), set `version: 19` — but **keep `name: 'fallback-provider'` exactly**.
2. Append it to the barrel array in `src/db/migrations/index.ts` after upstream's last migration.
3. No `schema_version` surgery needed: on the live DB the name matches and the migration is skipped; on a fresh DB it runs and adds the column. Do NOT change the `name` string — that would re-run `ALTER TABLE` on the live DB and fail (duplicate column).

Note: local commit history also added `016-pilot-activations` — that belongs to the pilot-activation customization (separate guide section), not this one; just don't lose it when editing the barrel.

### 8.2 `src/types.ts` — `ContainerConfigRow`

```ts
  /** Overflow provider used when the primary fails a turn on quota. */
  fallback_provider: string | null;
```

(after `provider`.)

### 8.3 `src/db/container-configs.ts`

- Add `'fallback_provider'` to `SCALAR_COLUMNS`.
- Add `fallback_provider` to the INSERT column list and `@fallback_provider` to VALUES in `createContainerConfig`.
- Widen `updateContainerConfigScalars`'s `Pick<...>` to include `'fallback_provider'`.

### 8.4 `src/container-config.ts`

Add to `ContainerConfig`:

```ts
  /** Overflow provider used when the primary fails a turn on quota. */
  fallbackProvider?: string;
```

and in `configFromDb`:

```ts
    fallbackProvider: row.fallback_provider ?? undefined,
```

(This flows into the materialized `groups/<folder>/container.json`, where the agent-runner's `loadConfig()` picks it up — verify the materialization serializes the whole `ContainerConfig` object; locally it does.)

### 8.5 `src/backfill-container-configs.ts`

Add `fallback_provider: null,` to the backfilled `ContainerConfigRow` literal.

### 8.6 `src/container-runner.ts` — merge the fallback provider's container contribution

Replace `resolveProviderContribution` with:

```ts
function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const ctx = {
    sessionDir: sessionDir(agentGroup.id, session.id),
    agentGroupId: agentGroup.id,
    hostEnv: process.env,
  };
  const fn = getProviderContainerConfig(provider);
  const contribution = fn ? fn(ctx) : {};

  // The quota-fallback provider needs its host-side contribution (auth
  // mounts, env passthrough) in the same container, otherwise the runner
  // can't switch to it mid-session. Merged with primary-wins on env keys.
  const fallbackName = containerConfig.fallbackProvider?.toLowerCase();
  if (fallbackName && fallbackName !== provider) {
    const fbFn = getProviderContainerConfig(fallbackName);
    if (fbFn) {
      const fb = fbFn(ctx);
      contribution.mounts = [...(contribution.mounts ?? []), ...(fb.mounts ?? [])];
      contribution.env = { ...(fb.env ?? {}), ...(contribution.env ?? {}) };
    }
  }
  return { provider, contribution };
}
```

(Adapt signature/names to upstream's current version; the load-bearing part is the fallback-merge block: fallback mounts appended, env merged primary-wins.)

### 8.7 Host-side codex provider config — `src/providers/codex.ts` (NEW) + barrel

```ts
/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // We only copy auth.json, not the full ~/.codex — config.toml would
  // get clobbered by the container on every wake anyway.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
  }

  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
```

And in `src/providers/index.ts` append: `import './codex.js';`

### 8.8 `src/cli/resources/groups.ts` — CLI flags (`7a468e92` included)

- `presentConfig`: add `fallback_provider: row.fallback_provider,` after `provider`.
- In `config update`: widen the `updates` Pick to include `'fallback_provider'`, update the description string to mention `--fallback-provider (or "none" to clear)` and `--image-tag (or "none" to clear)`, and add:

```ts
        if (args['fallback-provider'] !== undefined || args.fallback_provider !== undefined) {
          const fb = (args['fallback-provider'] ?? args.fallback_provider) as string;
          // "none" clears the fallback (CLI flags can't pass null directly)
          updates.fallback_provider = fb === 'none' ? null : fb;
        }
```

and replace the image_tag line with:

```ts
        if (args['image-tag'] !== undefined || args.image_tag !== undefined) {
          const tag = (args['image-tag'] ?? args.image_tag) as string;
          // "none" clears back to the default image (CLI flags can't pass null directly)
          updates.image_tag = tag === 'none' ? null : tag;
        }
```

Also update the "Nothing to update" error message to list `--fallback-provider`.

Usage after migration: `ncl groups config update --id <group> --fallback-provider codex` then `ncl groups restart --id <group>`.

---

## 9. Tests to port (all `bun:test`, run from `container/agent-runner/` with `bun test`)

| File | Covers |
|------|--------|
| `container/agent-runner/src/quota-fallback.test.ts` | `isGenuineQuotaError` / `isTransientLimit` classification (incl. Defect 1: transient 429 must not be genuine); `QuotaExhaustedError` carries prompt; quota-degraded + ❌-notice flag round-trips; `maybeWarnApproachingQuota` (five_hour-only, 90% threshold, 0-100 percentage semantics, once-per-window, re-arm on new resetsAt, fallback vs no-fallback wording, SDK warning flag alone not a trigger); `runFallbackTurn` (delivers + persists continuation, resumes stored thread, fallback-quota throws with thread kept, no-result throws, in-turn fresh-thread self-heal retry, idle-timeout abort of a stuck turn = Defect 2) |
| `container/agent-runner/src/handoff.test.ts` | `buildHandoffRecap`: empty session → `''`; both sides recapped oldest-first in `<system>`; pipeline ⚠️/❌/✅ notices excluded; non-text rows skipped + long messages truncated; message cap |
| `container/agent-runner/src/db/messages-out.test.ts` | idempotent guard: dup within window skipped, triple-send collapses to one row, distinct texts / different destinations not deduped, scheduled/recurring/non-chat never deduped; `countChatSendsSince` semantics |
| `container/agent-runner/src/providers/codex.factory.test.ts` | codex provider registration/factory (belongs with the codex-provider section, listed for completeness) |

Existing `poll-loop.test.ts` also gained cases in these commits — diff it against upstream's (restructured) version and port assertions that still apply rather than the file wholesale.

## 10. Verification checklist

1. `pnpm run build` (host) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.
2. `cd container/agent-runner && bun test` — locally 117 tests passed with this feature in place.
3. Start host; confirm `schema_version` gains no duplicate `fallback-provider` row and `container_configs` has the column.
4. `ncl groups config get --id <group>` shows `fallback_provider`.
5. Live smoke: set `FALLBACK_IDLE_TIMEOUT_MS` low in a test group only if simulating; otherwise force a quota event and confirm exactly one ⚠️ notice, Codex answer with recap continuity, and one ✅ on recovery.

## Known risks / gotchas

- Poll-loop is the highest-conflict surface: upstream's "one-door delivery" rework means every insertion point in §5 must be re-located semantically; watch especially where `markCompleted` and result dispatch moved.
- Hebrew notice strings are installation-specific; keep or translate deliberately.
- Codex fallback only works if the group's container image includes the codex CLI (per-group `image_tag` may need `ncl groups restart --rebuild`) and host `~/.codex/auth.json` or `OPENAI_API_KEY` exists.
- The quota regexes are tied to Anthropic's current banner wording — a wording change upstream silently disables detection.
- Do not rename the migration `name` (`fallback-provider`) — renumbering the file is safe, renaming the name re-runs the ALTER on live DBs and crashes startup.
