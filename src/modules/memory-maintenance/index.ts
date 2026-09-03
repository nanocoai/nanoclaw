/**
 * Memory-maintenance module: give a new agent the two series that maintain its
 * memory (see docs/memory.md), at its first conversation — the same message
 * that makes it introduce itself, whatever created the agent.
 *
 * An agent that was already talking is left alone: seeding it on a later thread
 * would be a backfill spread over time. Task sessions don't count as
 * conversations, since one can predate the first chat.
 */
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { registerSessionCreatedHook } from '../../router.js';
import { ensureMemoryMaintenanceTasks } from './tasks.js';

registerSessionCreatedHook(async (event) => {
  const agentGroupId = event.session.agent_group_id;
  const chats = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => !isTaskThread(s.thread_id));
  if (chats.length === 1) await ensureMemoryMaintenanceTasks(agentGroupId);
});
