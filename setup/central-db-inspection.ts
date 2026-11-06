import path from 'node:path';

import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';

export interface CentralDbInspection {
  displayName: string | null;
  registeredGroups: number;
  derivedGroups: number;
  /** Latest wiring time per channel type other than cli, default adapter instances only. */
  lastWiredAt: Record<string, string>;
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
  const result: CentralDbInspection = { displayName: null, registeredGroups: 0, derivedGroups: 0, lastWiredAt: {} };
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
    if ((await db.hasTable('messaging_groups')) && (await db.hasTable('messaging_group_agents'))) {
      // Verify reads the default credentials, so only default instances
      // count. A database from before named instances has no other kind.
      const query = (filter: string) =>
        db.all<{ channel: string; at: string }>(
          `SELECT mg.channel_type AS channel, MAX(mga.created_at) AS at FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
           WHERE mg.channel_type <> 'cli'${filter} GROUP BY mg.channel_type`,
        );
      const wired = await query(' AND mg.instance = mg.channel_type').catch((err: unknown) => {
        if (/no such column: mg\.instance/.test(String(err))) return query('');
        throw err;
      });
      result.lastWiredAt = Object.fromEntries(wired.map((r) => [r.channel, r.at]));
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
