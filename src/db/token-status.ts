import { getDb } from './connection.js';

export interface TokenStatusRow {
  agent_group_id: string;
  checked_at: number;
  expires_at: number | null;
  minutes_left: number | null;
  status: 'ok' | 'refreshed' | 'failed' | 'no-token';
  refreshed_at: number | null;
}

export function upsertTokenStatus(entry: {
  agentGroupId: string;
  checkedAt: number;
  expiresAt: number | null;
  minutesLeft: number | null;
  status: 'ok' | 'refreshed' | 'failed' | 'no-token';
}): void {
  getDb()
    .prepare(
      `INSERT INTO token_status (agent_group_id, checked_at, expires_at, minutes_left, status, refreshed_at)
       VALUES (@agentGroupId, @checkedAt, @expiresAt, @minutesLeft, @status, CASE WHEN @status = 'refreshed' THEN @checkedAt ELSE NULL END)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         checked_at   = excluded.checked_at,
         expires_at   = excluded.expires_at,
         minutes_left = excluded.minutes_left,
         status       = excluded.status,
         refreshed_at = CASE WHEN excluded.status = 'refreshed' THEN excluded.checked_at ELSE token_status.refreshed_at END`,
    )
    .run({
      agentGroupId: entry.agentGroupId,
      checkedAt: entry.checkedAt,
      expiresAt: entry.expiresAt,
      minutesLeft: entry.minutesLeft,
      status: entry.status,
    });
}

export function getAllTokenStatuses(): TokenStatusRow[] {
  return getDb().prepare('SELECT * FROM token_status ORDER BY agent_group_id').all() as TokenStatusRow[];
}
