/**
 * Legacy runner-facing outbound API, backed by the registered mailbox.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { getAgentMailbox } from '../mailbox/index.js';
import type { OutboundMessage } from '../mailbox/types.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Extra entries merged into system-action payloads for the duration of a
 * call, without the writing handler knowing about them. This is the seam
 * `extendTool` (../mcp-tools/server.ts) uses so an installed module can
 * add params to a base tool and have them land in the tool's outbound
 * payload while the base tool's source stays untouched.
 *
 * Scope is deliberately narrow: only `kind: 'system'` messages whose
 * content parses to a JSON object are decorated, and entries never
 * overwrite keys the handler wrote itself. Everything else passes through
 * byte-identical. With no active context (the default), this is a no-op.
 */
const outboundPassthrough = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with `entries` merged into system-action payloads it writes. */
export function withOutboundPassthrough<T>(entries: Record<string, unknown>, fn: () => T): T {
  return outboundPassthrough.run(entries, fn);
}

/** Apply any active passthrough entries to a system-action JSON payload. */
function decorateContent(msg: WriteMessageOut): string {
  const entries = outboundPassthrough.getStore();
  if (!entries || msg.kind !== 'system') return msg.content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return msg.content;

  const payload = parsed as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : msg.content;
}

function messageRow(message: OutboundMessage): MessageOutRow {
  return {
    id: message.id,
    seq: message.sequence,
    in_reply_to: message.inReplyTo,
    timestamp: message.timestamp,
    deliver_after: message.deliverAfter,
    recurrence: message.recurrence,
    kind: message.kind,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
  };
}

export function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  return getAgentMailbox().operations.writeMessageOut({
    id: msg.id,
    inReplyTo: msg.in_reply_to,
    deliverAfter: msg.deliver_after,
    recurrence: msg.recurrence,
    kind: msg.kind,
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
    content: decorateContent(msg),
  });
}

export function getMessageIdBySeq(seq: number): string | null {
  return getAgentMailbox().operations.getMessageIdBySeq(seq);
}

export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const routing = getAgentMailbox().operations.getRoutingBySeq(seq);
  return (
    routing && {
      channel_type: routing.channelType,
      platform_id: routing.platformId,
      thread_id: routing.threadId,
    }
  );
}

export function getUndeliveredMessages(): MessageOutRow[] {
  return getAgentMailbox().operations.getUndeliveredMessages().map(messageRow);
}
