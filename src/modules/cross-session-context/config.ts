/**
 * Cross-session context caps.
 *
 * Module-level constants for now — no DB config. Exported so the
 * router/delivery fan hooks, the backfill, the host-sweep pruner, and tests
 * share one source of truth.
 */

/** channel_type stamped on fanned rows (cross-stream contract — the
 *  container formatter renders these as <cross-session-context> blocks). */
export const ECHO_CHANNEL_TYPE = 'session-echo';

/** echo.surface value stamped on same-messaging-group sibling echoes — a DM's
 *  parallel conversation-threads seeing each other (audience-subset rule: same
 *  DM = same audience). Wire contract fields stay {surface,label}; this is
 *  just a new surface value. */
export const ECHO_SIBLING_SURFACE = 'dm-thread';

/** echo.surface value stamped on task-session-source echoes — a scheduled
 *  task's delivered user-facing send, fanned ONLY into sessions of the
 *  messaging group it was delivered to (audience-subset rule: that surface
 *  already displayed the message, so the fan widens nothing). */
export const ECHO_TASK_SURFACE = 'task-delivery';

/** Per-message text cap on echo rows: head-truncated, '…' appended when cut. */
export const ECHO_TEXT_MAX_CHARS = 500;

/** Pending echo rows the sweep pruner keeps per session (newest first).
 *  One cap for all sessions: under the same-conversation audience rule,
 *  task sessions receive no echoes. */
export const ECHO_BACKLOG_CAP = 50;

/**
 * The ambient-context horizon, in days. One number bounds three things:
 *   - which sessions of a conversation count as recently active (the fan
 *     audience and the backfill sources — see HOT_SESSION_LIMIT),
 *   - how far back a backfill reaches,
 *   - how long a pending echo row lives before the sweep pruner drops it.
 */
export const ECHO_MAX_AGE_DAYS = 3;
export const ECHO_MAX_AGE_MS = ECHO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The hot set: a conversation's HOT_SESSION_LIMIT most recently active
 * sessions (by `sessions.last_active`, within ECHO_MAX_AGE_DAYS), plus its
 * top-level session. Live echoes fan ONLY into the hot set, and a session
 * outside it catches up from the hot set when it next wakes. Everything the
 * module does per message is therefore O(HOT_SESSION_LIMIT), never O(sessions).
 */
export const HOT_SESSION_LIMIT = 8;

/** Mailbox sessions in flight at once during a fan or a backfill read. */
export const ECHO_CONCURRENCY = 8;

/** Backfill prelude surface: THIS DM's preceding timeline (first-class
 *  conversation history), distinct from live cross-thread fan echoes. */
export const ECHO_TIMELINE_SURFACE = 'dm-timeline';

/** Backfill prelude surface for group conversations: group surfaces can be
 *  per-thread too, so a new thread session is seeded with the channel's
 *  top-level timeline — same messaging group means the same audience. */
export const ECHO_CHANNEL_TIMELINE_SURFACE = 'channel-timeline';
