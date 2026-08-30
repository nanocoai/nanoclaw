/**
 * `ncl groups purge` — full agent-group teardown — and the shared FK-ordered
 * delete cascade it reuses (groups-purge skill).
 *
 * `groups.ts` wires this in at two points: the `delete` verb calls
 * `cascadeDeleteGroup` (the extracted cascade both verbs share), and the
 * resource's custom operations include `purge: purgeOperation`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { deleteAgentGroupImage, killGroupContainers } from '../../modules/groups-purge/teardown.js';
import { sessionsBaseDir } from '../../session-manager.js';
import type { CustomOperation } from '../crud.js';

export interface CascadeCounts {
  sessions: number;
  pending_questions: number;
  pending_approvals: number;
  agent_destinations_owned: number;
  agent_destinations_pointing: number;
  pending_sender_approvals: number;
  pending_channel_approvals: number;
  messaging_group_agents: number;
  agent_group_members: number;
  user_roles: number;
  container_configs: number;
}

/**
 * FK-ordered cascade of a group's dependent rows in one transaction. Callers
 * MUST verify the group exists first (both `delete` and `purge` throw
 * "group not found" before invoking). Returns each DELETE's `changes` count.
 *
 * Deliberately does NOT delete the `users` or `messaging_groups` rows — those
 * are shared identity / addressable channels that other groups may reuse; only
 * the group-scoped grants, memberships, and wirings are removed.
 */
export async function cascadeDeleteGroup(db: ReturnType<typeof getDb>, id: string): Promise<CascadeCounts> {
  const hasAgentDestinations = await hasTable(db, 'agent_destinations');
  const hasPendingApprovals = await hasTable(db, 'pending_approvals');

  // FK-ordered cascade. The async driver transaction rolls back the whole thing
  // if any statement throws (e.g. an FK constraint we missed), so the central
  // DB stays consistent. The `changes` counts describe exactly what the
  // transaction did, not a separate pre-flight snapshot.
  return db.transaction(async () => {
    const counts: CascadeCounts = {
      sessions: 0,
      pending_questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };

    if (hasAgentDestinations) {
      counts.agent_destinations_owned = (await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ?', id))
        .changes;
      counts.agent_destinations_pointing = (
        await db.run('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?', 'agent', id)
      ).changes;
    }
    counts.pending_questions = (
      await db.run(
        'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        id,
      )
    ).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = (
        await db.run(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
          id,
          id,
        )
      ).changes;
    }
    counts.sessions = (await db.run('DELETE FROM sessions WHERE agent_group_id = ?', id)).changes;
    counts.pending_sender_approvals = (
      await db.run('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?', id)
    ).changes;
    counts.pending_channel_approvals = (
      await db.run('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?', id)
    ).changes;
    counts.messaging_group_agents = (
      await db.run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', id)
    ).changes;
    counts.agent_group_members = (await db.run('DELETE FROM agent_group_members WHERE agent_group_id = ?', id)).changes;
    counts.user_roles = (await db.run('DELETE FROM user_roles WHERE agent_group_id = ?', id)).changes;
    // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
    // the explicit delete here mirrors the other tables and surfaces the count.
    counts.container_configs = (await db.run('DELETE FROM container_configs WHERE agent_group_id = ?', id)).changes;
    await db.run('DELETE FROM agent_groups WHERE id = ?', id);
    return counts;
  });
}

/**
 * The `purge` custom operation for the `groups` resource. Registered by
 * `groups.ts` alongside the built-in verbs.
 */
export const purgeOperation: CustomOperation = {
  access: 'approval',
  description:
    'Fully tear down an agent group. Kills running ' +
    'containers (no respawn), removes the per-group Docker image, removes on-disk groups/<folder>/ ' +
    'and data/v2-sessions/<group-id>/, then runs the FK-ordered DB cascade. ' +
    'Best-effort: external steps that fail are recorded in ' +
    '`notes` and skipped; the DB cascade always runs. ' +
    'Leaves shared identity (users, messaging_groups) and external service resources in place. ' +
    'Use --id <group-id>.',
  handler: async (args) => {
    const id = args.id as string;
    if (!id) throw new Error('--id is required');
    const db = getDb();

    // Read identity up front — the cascade deletes the rows that carry
    // `folder`, and the image tag / session dir derive from the id.
    const group = await getAgentGroup(id);
    if (!group) throw new Error(`group not found: ${id}`);

    const notes: string[] = [];
    async function step<T>(label: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
      try {
        return await fn();
      } catch (err) {
        notes.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return fallback;
      }
    }

    // 1. Kill running containers (no respawn) — frees the image and stops
    //    writes into the session dir we're about to remove.
    const killed = await step('kill', () => killGroupContainers(id, 'purged via ncl'), 0);
    // 2. Remove the per-group image (only the ag-scoped tag; never the base).
    const imageRemoved = await step('rmi', () => deleteAgentGroupImage(id), false);
    // 3. Remove on-disk dirs. force:true ⇒ a missing path is not an error.
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const sessionsDir = path.join(sessionsBaseDir(), id);
    const groupRemoved = await step(
      'rm-group-dir',
      () => {
        fs.rmSync(groupDir, { recursive: true, force: true });
        return true;
      },
      false,
    );
    const sessionsRemoved = await step(
      'rm-sessions-dir',
      () => {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
        return true;
      },
      false,
    );
    // 4. DB cascade LAST — runs even if steps 1–3 partially failed, so the
    //    central DB never strands a half-deleted group.
    const removed = await cascadeDeleteGroup(db, id);

    return {
      id,
      killed_containers: killed,
      image_removed: imageRemoved,
      dirs_removed: { group: groupRemoved, sessions: sessionsRemoved },
      db: removed,
      ...(notes.length ? { notes } : {}),
    };
  },
};
