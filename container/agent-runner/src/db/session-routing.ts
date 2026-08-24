/**
 * Current chat/thread routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by MCP tools to preserve the current thread when an explicitly named
 * destination resolves to the chat this session is bound to.
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

const TASK_THREAD_PREFIX = 'system:tasks:';

/** The task id encoded in this isolated task session's canonical thread id. */
export function getTaskSeriesId(): string | null {
  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}
