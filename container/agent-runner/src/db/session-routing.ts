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
 * The thread a send to `channelType`+`platformId` should land in — the thread
 * of the latest inbound row from that channel — plus that row's id for the a2a
 * return path.
 *
 * Reply threads come from here, not from `session_routing.thread_id`: the bound
 * thread is null for every session that isn't per-thread (shared, agent-shared,
 * DM sub-threads) even when the request arrived in a thread. Shared by the poll
 * loop and the send tools so text replies, `send_message` and `send_file` all
 * thread identically. Resolving per destination also keeps an agent-shared
 * session from stamping one channel's thread onto another.
 *
 * Returns null (send unthreaded) when nothing has arrived from that channel or
 * the read fails. Never throws.
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
