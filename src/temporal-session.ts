/**
 * Temporal ("incognito") session lifecycle.
 *
 * A temporal session is a distinct, memory-free throwaway session started by
 * the `/incognito` DM command. It stores the REAL thread_id + messaging_group_id
 * (so replies route back to the chat) and is disambiguated from the normal
 * session only by `temporal = 1`. Its container gets a fresh, empty workspace
 * (see container-runner's temporal spawn branch) and everything it writes lives
 * under the session folder, discarded wholesale on teardown.
 *
 * Lives in its own module (not session-manager) to avoid an import cycle:
 * container-runner already imports `sessionDir` from session-manager, and
 * `destroyTemporalSession` needs `killContainer` from container-runner.
 */
import fs from 'fs';

import { isContainerRunning, killContainer } from './container-runner.js';
import { createSession, deleteSession, findTemporalSession, updateSession } from './db/sessions.js';
import { log } from './log.js';
import { initSessionFolder, sessionDir } from './session-manager.js';
import type { Session } from './types.js';

function newSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create the active temporal session for a DM. Mirrors `resolveSession`
 * (same lookup-thread rule) but sets `temporal = 1`. DMs resolve to a null
 * thread, so the temporal session coexists with the normal (null-thread)
 * session for the same (group, mg).
 */
export function resolveTemporalSession(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;

  const existing = findTemporalSession(agentGroupId, messagingGroupId, lookupThreadId);
  if (existing) return { session: existing, created: false };

  const id = newSessionId();
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    temporal: 1,
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Temporal session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId });

  return { session, created: true };
}

/**
 * Tear down a temporal session: kill its container (if running), close + delete
 * the row, and remove its session folder (ephemeral workspace + isolated
 * `.claude` + both session DBs) so nothing persists.
 *
 * When a container is running, cleanup is deferred to the container's exit so we
 * never pull the session folder out from under a live process. `killContainer`
 * only fires `onExit` when an active container exists, so the not-running path
 * cleans up immediately.
 */
export function destroyTemporalSession(session: Session): void {
  const cleanup = (): void => {
    updateSession(session.id, { status: 'closed' });
    deleteSession(session.id);
    fs.rmSync(sessionDir(session.agent_group_id, session.id), { recursive: true, force: true });
    log.info('Temporal session destroyed', { id: session.id, agentGroupId: session.agent_group_id });
  };

  if (isContainerRunning(session.id)) {
    killContainer(session.id, 'temporal-end', cleanup);
  } else {
    cleanup();
  }
}
