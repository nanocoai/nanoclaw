/**
 * Cross-session context module.
 *
 * Push layer: accumulate fan-out of triggering user messages (router hook)
 * and delivered user-facing agent messages (delivery hook) into sibling
 * sessions OF THE SAME CONVERSATION as trigger=0 'session-echo' rows (a message
 * fans only into sessions of the messaging group it appeared in —
 * cross-conversation awareness is pull-only). Backlog capped by the
 * host-sweep pruner. Pull layer: `ncl sessions history` (registered by
 * src/cli/resources/sessions.ts).
 *
 * No import-time registration — the hooks are direct calls from
 * router.ts / delivery.ts / host-sweep.ts, kept modular.
 */
export {
  ECHO_BACKLOG_CAP,
  ECHO_CHANNEL_TYPE,
  ECHO_MAX_AGE_DAYS,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TEXT_MAX_CHARS,
} from './config.js';
export {
  buildDeliveredEchoLabel,
  buildEchoLabel,
  buildSiblingEchoLabel,
  echoRowId,
  fanInboundMessage,
  fanOutboundMessage,
  selectEchoTargets,
  truncateEchoText,
  type EchoTargetCandidate,
  type EchoWireSurface,
} from './fan.js';
export { pruneEchoBacklog } from './prune.js';
export {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_TEXT_MAX_CHARS,
  sessionHistory,
  type HistoryRow,
} from './history.js';
export { backfillNewSession, BACKFILL_LIMIT } from './backfill.js';
