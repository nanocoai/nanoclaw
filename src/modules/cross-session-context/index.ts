/**
 * Cross-session context module.
 *
 * Push layer: fan-out of triggering user messages (router hook) and delivered
 * user-facing agent messages (delivery hook) into sibling sessions OF THE
 * SAME CONVERSATION as trigger=0 'session-echo' rows — bounded to the
 * conversation's hot set (HOT_SESSION_LIMIT most recently active sessions
 * within ECHO_MAX_AGE_DAYS, plus its top-level session), written concurrently,
 * off the message's critical path. Cross-conversation awareness is pull-only.
 * Backlog capped by the host-sweep pruner.
 *
 * Pull layer: a new or long-idle session is seeded from the hot set at wake
 * (backfill.ts); `ncl sessions history` gives full-depth catch-up on demand
 * (registered by src/cli/resources/sessions.ts).
 *
 * No import-time registration — the hooks are direct calls from
 * router.ts / delivery.ts / reconcile-session.ts, kept modular.
 */
export {
  ECHO_BACKLOG_CAP,
  ECHO_CHANNEL_TYPE,
  ECHO_CONCURRENCY,
  ECHO_MAX_AGE_DAYS,
  ECHO_MAX_AGE_MS,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TEXT_MAX_CHARS,
  HOT_SESSION_LIMIT,
} from './config.js';
export {
  buildDeliveredEchoLabel,
  buildEchoLabel,
  buildSiblingEchoLabel,
  echoRowId,
  fanInboundMessage,
  fanOutboundMessage,
  loadHotCandidates,
  selectEchoTargets,
  selectHotSessions,
  settleEchoFans,
  truncateEchoText,
  type EchoTargetCandidate,
  type EchoWireSurface,
} from './fan.js';
export { mapConcurrent } from './parallel.js';
export { pruneEchoBacklog } from './prune.js';
export {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_TEXT_MAX_CHARS,
  sessionHistory,
  type HistoryRow,
} from './history.js';
export { backfillSession, BACKFILL_LIMIT, type BackfillOptions } from './backfill.js';
