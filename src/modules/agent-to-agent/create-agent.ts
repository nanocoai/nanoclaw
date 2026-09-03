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
 * `performCreateAgent` is the module-private plain-create body; a request
 * carrying a `template` ref instead stamps via createAgentFromTemplate after
 * the host fetches the template into the local templates/ dir. The template
 * ref rides the SAME agents.create authorization (no separate gate) — the
 * hold payload carries it and the grant binding (./guard.ts) pins the
 * approved replay to it.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { isValidTemplateRef } from '../../templates/local-dir.js';
import { ensureTemplateLocal, hasLocalTemplate, type EnsureTemplateResult } from '../../templates/registry.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'agent-created');
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export async function validateCreateAgent(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const name = typeof content.name === 'string' ? content.name : '';
  if (!name) {
    await notifyAgent(session, 'create_agent failed: name is required.');
    return false;
  }
  // Grammar-only check (no disk, no network) — a malformed ref never reaches a
  // hold, so an admin is never carded for a request that cannot execute.
  if (
    content.template !== undefined &&
    (typeof content.template !== 'string' || !isValidTemplateRef(content.template))
  ) {
    await notifyAgent(
      session,
      `create_agent failed: invalid template ref "${String(content.template)}". Refs look like "sales/sdr" (see ncl templates list).`,
    );
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return false;
  }
  return true;
}

/**
 * The hold payload every create_agent hold carries. The payload is the grant
 * binding: the approved replay re-enters with it as content, so a template
 * ref left out here would stamp nothing on approve. A templated hold carries
 * NO instructions — the template branch ignores them (the template supplies
 * the persona), so the grant only binds what will actually execute. Wrappers
 * that re-register the action (e.g. slack-agent-flow) spread their own fields
 * on top of this shared core.
 */
export function buildCreateAgentHoldPayload(content: Record<string, unknown>): Record<string, unknown> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const template = typeof content.template === 'string' && content.template ? content.template : undefined;
  return { name, instructions: template ? null : instructions, ...(template ? { template } : {}) };
}

/**
 * The template sentence on a create_agent approval card: the admin must see
 * the ref and whether it resolves to the existing local copy or a registry
 * fetch. Empty for a plain create. Shared with wrapper cards.
 */
export function templateApprovalNote(template: string | undefined): string {
  if (!template) return '';
  return ` It will be stamped from template "${template}" (${
    hasLocalTemplate(template) ? 'using the existing local copy' : 'fetched from the public template registry'
  }).`;
}

/** Human-readable stamp provenance: registry clone HEAD, or the local copy. */
export function formatTemplateProvenance(commit: string | undefined): string {
  return commit ? `commit ${commit.slice(0, 7)}` : 'local copy';
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const template = typeof content.template === 'string' && content.template ? content.template : undefined;
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: buildCreateAgentHoldPayload(content),
    title: `Create agent: ${name}`,
    question: `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" (a new agent group with its own workspace and container).${templateApprovalNote(template)} Approve?`,
  });
}

export interface CreateAgentOptions {
  /**
   * Suppress the terminal `Agent "<name>" created…` success notify. Error
   * notifies (collision, invalid path) still fire. For wrappers whose own
   * completion text is the requester's only "done" signal — e.g.
   * slack-agent-flow, where Slack provisioning runs AFTER this returns and
   * relaying the upstream text would report "done" ~a minute early.
   */
  suppressCreatedNotify?: boolean;
}

export interface CreateAgentOutcome {
  agentGroupId: string;
  localName: string;
  /** Present when the group was stamped from a template; commit is the registry clone HEAD (absent when the local copy won). */
  template?: { ref: string; commit?: string };
}

/** Guard allow body: performs the creation (fresh global-scope call or approved replay). */
export async function createAgent(
  content: Record<string, unknown>,
  session: Session,
  options?: CreateAgentOptions,
): Promise<CreateAgentOutcome | undefined> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const template = typeof content.template === 'string' && content.template ? content.template : undefined;
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!name || !sourceGroup) return; // precheck already answered the requester

  const notify = (text: string): Promise<void> => notifyAgent(session, text);
  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (await getDestinationByName(sourceGroup.id, localName)) {
    await notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Subagent path: a child inherits its creator's EFFECTIVE provider, NOT a
  // hardcoded fallback — so a child is never spawned on a runtime the parent
  // can't reach (e.g. a codex-only install where claude isn't authenticated).
  // A parent with no explicit provider passes undefined through: the config
  // seam (ensureContainerConfig) owns the DEFAULT_AGENT_PROVIDER fallback,
  // the same default the parent itself runs on. The operator can still flip a
  // child later with `ncl groups config update --provider`.
  const parentProvider = (await getContainerConfig(sourceGroup.id))?.provider ?? undefined;

  if (template) {
    return createFromTemplate(template, name, localName, parentProvider, session, sourceGroup, notify, options);
  }
  return performCreateAgent(name, localName, instructions, parentProvider, session, sourceGroup, notify, options);
}

/**
 * Template branch: fetch-then-stamp. The fetch precedes every DB write, so a
 * fetch failure is saga-clean — nothing was created, nothing to roll back.
 * Plugin-content hardening is enforced at stamp time by copyPluginDir
 * (src/templates/plugin-dir.ts), not here.
 */
async function createFromTemplate(
  template: string,
  name: string,
  localName: string,
  parentProvider: string | undefined,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => Promise<void>,
  options?: CreateAgentOptions,
): Promise<CreateAgentOutcome | undefined> {
  let local: EnsureTemplateResult;
  try {
    local = await ensureTemplateLocal(template);
  } catch (err) {
    await notify(
      `create_agent failed: could not fetch template "${template}": ${err instanceof Error ? err.message : String(err)}. Nothing was created.`,
    );
    return;
  }

  let stamped;
  try {
    stamped = await createAgentFromTemplate(template, { name, provider: parentProvider });
  } catch (err) {
    // The requester must always be answered. Partial central-DB state on a
    // mid-stamp throw is the stamping engine's existing exposure (same as
    // `ncl groups create --template`); rollback is out of scope.
    const msg = err instanceof Error ? err.message : String(err);
    await notify(`create_agent failed: template "${template}" could not be stamped: ${msg}.`);
    log.error('create_agent template stamp failed', { template, err });
    return;
  }

  const now = new Date().toISOString();
  await wireNewAgent(sourceGroup.id, localName, stamped.group.id, session, now);

  if (!options?.suppressCreatedNotify) {
    const provenance = formatTemplateProvenance(local.commit);
    const reportSuffix = stamped.report.length ? `\n${stamped.report.join('\n')}` : '';
    await notify(
      `Agent "${localName}" created from template "${template}" (${provenance}). You can now message it with send_message({ to: "${localName}", ... }).${reportSuffix}`,
    );
  }
  log.info('Agent group created from template', {
    agentGroupId: stamped.group.id,
    name,
    localName,
    template,
    source: local.source,
    commit: local.commit,
    parent: sourceGroup.id,
  });
  return {
    agentGroupId: stamped.group.id,
    localName,
    template: { ref: template, ...(local.commit ? { commit: local.commit } : {}) },
  };
}

/**
 * Core plain creation: writes the new agent group + bidirectional destinations
 * and scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the guard's agents.create decision) — never call
 * this from an unauthorized path, as it performs privileged central-DB
 * writes a confined container is
 * otherwise barred from.
 */
async function performCreateAgent(
  name: string,
  localName: string,
  instructions: string | null,
  parentProvider: string | undefined,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => Promise<void>,
  options?: CreateAgentOptions,
): Promise<CreateAgentOutcome | undefined> {
  // Derive a safe folder name, deduplicated globally across
  // agent_groups.folder AND the on-disk groups/ dir: a folder present on disk
  // with no claiming DB row is deleted-group residue, and adopting it would
  // silently re-scope the old group's data under the new agent's identity —
  // skip to the next suffix instead (templates/create-agent.ts precedent).
  let folder = localName;
  let suffix = 2;
  while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    await notify(`Cannot create agent "${name}": invalid folder path.`);
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
  await createAgentGroup(newGroup);
  await initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });

  await wireNewAgent(sourceGroup.id, localName, agentGroupId, session, now);

  if (!options?.suppressCreatedNotify) {
    await notify(
      `Agent "${localName}" created. You can now message it with send_message({ to: "${localName}", ... }).`,
    );
  }
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
  return { agentGroupId, localName };
}

/** Wire a newly created child into its creator's messaging fabric — both creation branches call this. */
async function wireNewAgent(
  sourceGroupId: string,
  localName: string,
  newAgentGroupId: string,
  session: Session,
  now: string,
): Promise<void> {
  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  await createDestination({
    agent_group_id: sourceGroupId,
    local_name: localName,
    target_type: 'agent',
    target_id: newAgentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (await getDestinationByName(newAgentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  await createDestination({
    agent_group_id: newAgentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroupId,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  await writeDestinations(session.agent_group_id, session.id);
}
