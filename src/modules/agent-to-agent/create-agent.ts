/**
 * `create_agent` delivery-action bodies.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side: the delivery
 * registry wraps this action with the guard, whose `agents.create` decision
 * (./guard.ts) is the old cli_scope branch verbatim — trusted global-scope
 * groups allow, everything else (including unknown config, fail-closed)
 * holds for admin approval. On approve the continuation re-enters the
 * wrapped action with the approval row as its grant and `createAgent` runs.
 * `performCreateAgent` is the module-private body.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export function validateCreateAgent(content: Record<string, unknown>, session: Session): boolean {
  const name = typeof content.name === 'string' ? content.name : '';
  if (!name) {
    notifyAgent(session, 'create_agent failed: name is required.');
    return false;
  }
  if (!getAgentGroup(session.agent_group_id)) {
    notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return false;
  }
  return true;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: { name, instructions },
    title: `Create agent: ${name}`,
    question: `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" (a new agent group with its own workspace and container). Approve?`,
  });
}

/** Guard allow body: performs the creation (fresh global-scope call or approved replay). */
export async function createAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!name || !sourceGroup) return; // precheck already answered the requester

  await performCreateAgent(name, instructions, session, sourceGroup, (text) => notifyAgent(session, text));
}

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the guard's agents.create decision) — never call
 * this from an unauthorized path, as it performs privileged central-DB
 * writes a confined container is
 * otherwise barred from.
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
): Promise<void> {
  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  // Subagent path: a child inherits its creator's EFFECTIVE provider, NOT the
  // instance-wide default — so a child is never spawned on a runtime the parent
  // can't reach (e.g. a codex-only install where claude isn't authenticated).
  // Passing it explicitly to initGroupFilesystem pins the child's scaffold and
  // stamps its config row in one step (a NULL parent resolves to claude). The
  // operator can still flip a child later with `ncl groups config update
  // --provider`.
  const parentProvider = getContainerConfig(sourceGroup.id)?.provider ?? 'claude';
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  notify(`Agent "${localName}" created. You can now message it with send_message({ to: "${localName}", ... }).`);
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
}
