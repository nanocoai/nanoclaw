/**
 * Legacy runner-facing inbound API, backed by the registered mailbox.
 */
import { getConfig } from '../config.js';
import { getAgentMailbox } from '../mailbox/index.js';
import type { InboundMessage } from '../mailbox/types.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: InboundMessage['kind'];
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
}

function messageRow(message: InboundMessage): MessageInRow {
  return {
    id: message.id,
    seq: message.sequence,
    kind: message.kind,
    timestamp: message.timestamp,
    status: message.status,
    process_after: message.processAfter,
    recurrence: message.recurrence,
    series_id: message.seriesId,
    tries: message.tries,
    trigger: message.trigger ? 1 : 0,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
    source_session_id: message.sourceSessionId,
    on_wake: message.onWake ? 1 : 0,
  };
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
 * Fetch pending messages while excluding work already claimed by this runner.
 *
 * Selection is two-phase so accumulated context can never crowd a wake row
 * out of the batch: all due trigger=1 rows come first (oldest-first, up to
 * `maxMessagesPerPrompt`), then remaining slots fill with the NEWEST due
 * trigger=0 rows. Without this, ≥cap accumulated context rows (e.g.
 * non-engaged group messages) newer than a due task row would push the task
 * itself out of the batch. The combined batch is returned in chronological
 * order (oldest first). Host's countDueMessages gates waking on trigger=1
 * separately through the host mailbox contract.
 *
 * ORDER MATTERS: claim filtering runs BEFORE the cap windowing. Rows this
 * runner already claimed can remain pending until the host sweep syncs state;
 * windowing first
 * would let a cap-sized batch of those claimed rows fill the window, the
 * ack filter would then empty it, and genuinely new rows beyond the window
 * would be invisible for the rest of the turn.
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  return getAgentMailbox().operations.getPendingMessages(getMaxMessagesPerPrompt(), isFirstPoll).map(messageRow);
}

export function markProcessing(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'processing');
}

export function markCompleted(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'completed');
}

export function markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  getAgentMailbox().operations.markScriptSkipped(skips);
}

export function markFailed(id: string): void {
  getAgentMailbox().operations.markMessages([id], 'failed');
}

export function getMessageIn(id: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.getMessageIn(id);
  return message && messageRow(message);
}

export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findQuestionResponse(questionId);
  return message && messageRow(message);
}

export function findCliResponse(requestId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findCliResponse(requestId);
  return message && messageRow(message);
}
