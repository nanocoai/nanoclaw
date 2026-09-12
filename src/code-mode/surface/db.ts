/**
 * The binding table — one row per coding session that has a chat surface.
 *
 * `agent_group_id` is the primary key because a sandbox IS a code-mode agent
 * group and holds one coding session (`system:sandbox`, session-manager.ts
 * resolveSandboxSession). `provider` is the chat platform (the channel type
 * the surface provider registered under), `surface_id` the provider's id
 * for the surface, `messaging_group_id` the messaging_groups row the surface
 * is wired through (the ordinary group ↔ chat mechanism — nothing here
 * delivers a message itself).
 *
 * Mirror bookkeeping lives beside the ids so a host restart resumes where it
 * left off: the last status sent, the last turn the diff view rendered, the
 * stop mark, and the event cursor of the long-poll.
 */
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerMigration } from '../../db/migrations/index.js';

export const SESSION_SURFACES_TABLE = 'code_session_surfaces';

registerMigration({
  version: 3,
  name: 'module:code-mode:session-surfaces',
  async up(db: DbDriver) {
    await db.exec(`CREATE TABLE IF NOT EXISTS ${SESSION_SURFACES_TABLE} (
      agent_group_id     TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
      provider           TEXT NOT NULL,
      surface_id         TEXT NOT NULL,
      session_id         TEXT NOT NULL,
      messaging_group_id TEXT,
      title              TEXT NOT NULL,
      last_status        TEXT,
      last_status_at     TEXT,
      stopped_at         TEXT,
      last_turn_seq      BIGINT NOT NULL DEFAULT 0,
      events_cursor      TEXT,
      archived_at        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      UNIQUE (provider, surface_id)
    )`);
  },
});

export interface SessionSurfaceRow {
  agent_group_id: string;
  provider: string;
  surface_id: string;
  session_id: string;
  messaging_group_id: string | null;
  title: string;
  last_status: string | null;
  last_status_at: string | null;
  stopped_at: string | null;
  last_turn_seq: number;
  events_cursor: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SessionSurfacePatch = Partial<
  Pick<
    SessionSurfaceRow,
    | 'messaging_group_id'
    | 'title'
    | 'last_status'
    | 'last_status_at'
    | 'stopped_at'
    | 'last_turn_seq'
    | 'events_cursor'
    | 'archived_at'
  >
>;

export async function insertSessionSurface(
  row: Omit<SessionSurfaceRow, 'created_at' | 'updated_at'> & Partial<Pick<SessionSurfaceRow, 'created_at'>>,
): Promise<SessionSurfaceRow> {
  const at = new Date().toISOString();
  const full: SessionSurfaceRow = { ...row, created_at: row.created_at ?? at, updated_at: at };
  await getDb().run(
    `INSERT INTO ${SESSION_SURFACES_TABLE} (
       agent_group_id, provider, surface_id, session_id, messaging_group_id, title,
       last_status, last_status_at, stopped_at, last_turn_seq, events_cursor, archived_at, created_at, updated_at
     ) VALUES (
       @agent_group_id, @provider, @surface_id, @session_id, @messaging_group_id, @title,
       @last_status, @last_status_at, @stopped_at, @last_turn_seq, @events_cursor, @archived_at, @created_at, @updated_at
     )`,
    full,
  );
  return full;
}

export async function getSessionSurfaceByGroup(agentGroupId: string): Promise<SessionSurfaceRow | undefined> {
  return getDb().get<SessionSurfaceRow>(
    `SELECT * FROM ${SESSION_SURFACES_TABLE} WHERE agent_group_id = ?`,
    agentGroupId,
  );
}

export async function getSessionSurfaceBySurface(
  provider: string,
  surfaceId: string,
): Promise<SessionSurfaceRow | undefined> {
  return getDb().get<SessionSurfaceRow>(
    `SELECT * FROM ${SESSION_SURFACES_TABLE} WHERE provider = ? AND surface_id = ?`,
    provider,
    surfaceId,
  );
}

/** Every binding that still has a live surface (archived rows are history). */
export async function listOpenSessionSurfaces(): Promise<SessionSurfaceRow[]> {
  return getDb().all<SessionSurfaceRow>(
    `SELECT * FROM ${SESSION_SURFACES_TABLE} WHERE archived_at IS NULL ORDER BY created_at`,
  );
}

export async function updateSessionSurface(agentGroupId: string, patch: SessionSurfacePatch): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId, updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = @${key}`);
    values[key] = value;
  }
  if (fields.length === 0) return;
  fields.push('updated_at = @updated_at');
  await getDb().run(
    `UPDATE ${SESSION_SURFACES_TABLE} SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`,
    values,
  );
}

export async function deleteSessionSurface(agentGroupId: string): Promise<void> {
  await getDb().run(`DELETE FROM ${SESSION_SURFACES_TABLE} WHERE agent_group_id = ?`, agentGroupId);
}
