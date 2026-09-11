/**
 * The binding table — one row per coding session that has a chat surface.
 *
 * `agent_group_id` is the primary key because a sandbox IS a code-mode agent
 * group and holds one coding session (`system:sandbox`, session-manager.ts
 * resolveSandboxSession); the service's `sessionId` is that same group id.
 * `channel_id` is the chat platform's channel; `messaging_group_id` is the
 * messaging_groups row the channel is wired through (the ordinary group ↔
 * chat mechanism — nothing here delivers a message itself).
 *
 * Mirror bookkeeping lives beside the ids so a host restart resumes where it
 * left off: the last status sent, the last turn the diff view rendered, the
 * stop mark, and the event cursor of the long-poll.
 */
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import type { DbDriver } from '../../db/driver.js';

export const SESSION_CHANNELS_TABLE = 'code_session_channels';

registerMigration({
  version: 3,
  name: 'module:code-mode:session-channels',
  async up(db: DbDriver) {
    await db.exec(`CREATE TABLE IF NOT EXISTS ${SESSION_CHANNELS_TABLE} (
      agent_group_id     TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
      channel_id         TEXT NOT NULL UNIQUE,
      session_id         TEXT NOT NULL,
      messaging_group_id TEXT,
      service_base       TEXT NOT NULL,
      app_id             TEXT NOT NULL,
      title              TEXT NOT NULL,
      last_status        TEXT,
      last_status_at     TEXT,
      stopped_at         TEXT,
      last_turn_seq      BIGINT NOT NULL DEFAULT 0,
      events_cursor      TEXT,
      archived_at        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )`);
  },
});

export interface SessionChannelRow {
  agent_group_id: string;
  channel_id: string;
  session_id: string;
  messaging_group_id: string | null;
  service_base: string;
  app_id: string;
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

export type SessionChannelPatch = Partial<
  Pick<
    SessionChannelRow,
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

export async function insertSessionChannel(
  row: Omit<SessionChannelRow, 'created_at' | 'updated_at'> & Partial<Pick<SessionChannelRow, 'created_at'>>,
): Promise<SessionChannelRow> {
  const at = new Date().toISOString();
  const full: SessionChannelRow = { ...row, created_at: row.created_at ?? at, updated_at: at };
  await getDb().run(
    `INSERT INTO ${SESSION_CHANNELS_TABLE} (
       agent_group_id, channel_id, session_id, messaging_group_id, service_base, app_id, title,
       last_status, last_status_at, stopped_at, last_turn_seq, events_cursor, archived_at, created_at, updated_at
     ) VALUES (
       @agent_group_id, @channel_id, @session_id, @messaging_group_id, @service_base, @app_id, @title,
       @last_status, @last_status_at, @stopped_at, @last_turn_seq, @events_cursor, @archived_at, @created_at, @updated_at
     )`,
    full,
  );
  return full;
}

export async function getSessionChannelByGroup(agentGroupId: string): Promise<SessionChannelRow | undefined> {
  return getDb().get<SessionChannelRow>(
    `SELECT * FROM ${SESSION_CHANNELS_TABLE} WHERE agent_group_id = ?`,
    agentGroupId,
  );
}

export async function getSessionChannelByChannel(channelId: string): Promise<SessionChannelRow | undefined> {
  return getDb().get<SessionChannelRow>(`SELECT * FROM ${SESSION_CHANNELS_TABLE} WHERE channel_id = ?`, channelId);
}

/** Every binding that still has a live channel (archived rows are history). */
export async function listOpenSessionChannels(): Promise<SessionChannelRow[]> {
  return getDb().all<SessionChannelRow>(
    `SELECT * FROM ${SESSION_CHANNELS_TABLE} WHERE archived_at IS NULL ORDER BY created_at`,
  );
}

export async function updateSessionChannel(agentGroupId: string, patch: SessionChannelPatch): Promise<void> {
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
    `UPDATE ${SESSION_CHANNELS_TABLE} SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`,
    values,
  );
}

export async function deleteSessionChannel(agentGroupId: string): Promise<void> {
  await getDb().run(`DELETE FROM ${SESSION_CHANNELS_TABLE} WHERE agent_group_id = ?`, agentGroupId);
}
