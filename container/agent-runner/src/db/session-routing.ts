/**
 * Reply routing: the chat this session is bound to (`getSessionRouting`, written
 * by the host on every wake — see src/session-manager.ts `writeSessionRouting`)
 * and the thread a given channel is currently in (`resolveDestinationThread`).
 */
import { getAgentMailbox } from '../mailbox/index.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const routing = getAgentMailbox().operations.getSessionRouting();
  return {
    channel_type: routing.channelType,
    platform_id: routing.platformId,
    thread_id: routing.threadId,
  };
}

/**
 * The thread a send to `channelType`+`platformId` should land in: the thread of
 * the most recent inbound row from that channel, plus that row's id for the a2a
 * return path.
 *
 * This — not `session_routing.thread_id` — is where a reply's thread comes from.
 * The session's bound thread is null for every chat session that isn't per-thread
 * (shared and agent-shared sessions, DM sub-threads), while a request can arrive
 * in a thread regardless. Shared by the poll loop and the MCP send tools so text
 * replies, `send_message` and `send_file` all thread identically, and resolved
 * per destination so an agent-shared session never stamps one channel's thread
 * onto another.
 *
 * Returns null when nothing has arrived from that channel yet, or when the read
 * fails; the caller then sends without a thread. Never throws.
 */
export function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    return getAgentMailbox().operations.getLatestInboundRoute(channelType, platformId);
  } catch (err) {
    console.error(
      `[session-routing] resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/** The task id encoded in this isolated task session's canonical thread id. */
export function getTaskSeriesId(): string | null {
  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}
