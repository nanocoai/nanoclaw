import path from 'node:path';

import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';

export interface CentralDbInspection {
  displayName: string | null;
  registeredGroups: number;
  derivedGroups: number;
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
  const result: CentralDbInspection = { displayName: null, registeredGroups: 0, derivedGroups: 0 };
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
    return result;
  } finally {
    await closeDb();
  }
}
