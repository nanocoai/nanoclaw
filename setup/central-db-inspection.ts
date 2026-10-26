import path from 'node:path';

import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';

export interface CentralDbInspection {
  displayName: string | null;
  registeredGroups: number;
  derivedGroups: number;
  /** Global owners. A terminal-only install has none: init-cli-agent leaves the grant for later. */
  owners: number;
  /** Whoever channel approval can ask about a new chat: owners and global or first-group admins. */
  approvers: number;
  /** Channel types other than cli with at least one wired chat. */
  wiredChannels: string[];
  /** Channel types other than cli with an unwired, undenied chat whose messages were dropped. */
  droppedChannels: string[];
}

function isMissingSqliteFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CANTOPEN'
  );
}

/** Read-only setup inspection through the installed central-DB composition. */
export async function inspectCentralDb(projectRoot: string): Promise<CentralDbInspection> {
  const result: CentralDbInspection = {
    displayName: null,
    registeredGroups: 0,
    derivedGroups: 0,
    owners: 0,
    approvers: 0,
    wiredChannels: [],
    droppedChannels: [],
  };
  const dbPath = path.join(projectRoot, 'data', 'v2.db');

  let db: DbDriver;
  try {
    db = await initDb(dbPath, { role: 'tool', readonly: true });
  } catch (error) {
    if (isMissingSqliteFile(error)) return result;
    throw error;
  }

  try {
    if (await db.hasTable('users')) {
      const row = await db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE id = 'cli:local'`);
      result.displayName = row?.display_name?.trim() || null;
    }
    if ((await db.hasTable('agent_groups')) && (await db.hasTable('messaging_group_agents'))) {
      const row = await db.get<{ count: number }>(
        `SELECT COUNT(DISTINCT ag.id) AS count FROM agent_groups ag
         JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id`,
      );
      result.registeredGroups = row?.count ?? 0;
    }
    if (await db.hasTable('container_configs')) {
      const row = await db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM container_configs WHERE image_tag IS NOT NULL',
      );
      result.derivedGroups = row?.count ?? 0;
    }
    if (await db.hasTable('user_roles')) {
      const owners = await db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL`,
      );
      result.owners = Number(owners?.count ?? 0);
      // Mirrors requestChannelApproval, which asks pickApprover about the
      // first agent group by name: an admin scoped elsewhere is never asked.
      if (await db.hasTable('agent_groups')) {
        const approvers = await db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM user_roles
           WHERE role IN ('owner', 'admin')
             AND (agent_group_id IS NULL OR agent_group_id = (SELECT id FROM agent_groups ORDER BY name LIMIT 1))`,
        );
        result.approvers = Number(approvers?.count ?? 0);
      }
    }
    if ((await db.hasTable('messaging_groups')) && (await db.hasTable('messaging_group_agents'))) {
      const wired = await db.all<{ channel: string }>(
        `SELECT DISTINCT mg.channel_type AS channel FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
         WHERE mg.channel_type <> 'cli' ORDER BY channel`,
      );
      result.wiredChannels = wired.map((r) => r.channel);
      // The router records these before asking an approver, so with nobody
      // to ask they are the chats that never reach an agent. Setup can run
      // before migrations add denied_at; no column means no evidence yet.
      if (await db.hasTable('unregistered_senders')) {
        try {
          const dropped = await db.all<{ channel: string }>(
            `SELECT DISTINCT mg.channel_type AS channel FROM unregistered_senders us
             JOIN messaging_groups mg ON mg.id = us.messaging_group_id
             WHERE us.reason = 'no_agent_wired' AND mg.channel_type <> 'cli' AND mg.denied_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM messaging_group_agents mga WHERE mga.messaging_group_id = mg.id)
             ORDER BY channel`,
          );
          result.droppedChannels = dropped.map((r) => r.channel);
        } catch {
          result.droppedChannels = [];
        }
      }
    }
    return result;
  } finally {
    await closeDb();
  }
}

export interface AgentSessionState {
  agentGroupId: string;
  sessionId: string;
  containerStatus: string | null;
}

/** The newest active session of the agent group in `folder`, read-only. */
export async function inspectAgentSession(projectRoot: string, folder: string): Promise<AgentSessionState | null> {
  const dbPath = path.join(projectRoot, 'data', 'v2.db');

  let db: DbDriver;
  try {
    db = await initDb(dbPath, { role: 'tool', readonly: true });
  } catch (error) {
    if (isMissingSqliteFile(error)) return null;
    throw error;
  }

  try {
    if (!(await db.hasTable('sessions')) || !(await db.hasTable('agent_groups'))) return null;
    const row = await db.get<{ id: string; agent_group_id: string; container_status: string | null }>(
      `SELECT s.id, s.agent_group_id, s.container_status FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       WHERE ag.folder = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      folder,
    );
    return row ? { agentGroupId: row.agent_group_id, sessionId: row.id, containerStatus: row.container_status } : null;
  } finally {
    await closeDb();
  }
}
