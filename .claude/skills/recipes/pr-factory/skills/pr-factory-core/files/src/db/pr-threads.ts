/**
 * pr_threads — central index of PR ↔ chat-thread ↔ session.
 *
 * With per-PR sessions inside a single PR Factory Worker agent group, this
 * table maps (chat thread) ↔ (repo, PR#) ↔ (session) without a folder on
 * disk. The delivering bot identity is not recorded here — outbound identity
 * is resolved per messaging group via `messaging_groups.instance`.
 *
 * Used by:
 *   - pr-factory handler: insert on PR opened; lookup + repoint on synchronize/close
 *   - pr-factory orchestrator: lookup by (repo_full_name, pr_number) when test results land
 *   - pr-factory testing/gh/skill-edit gates + reactions: lookup by (session_id)
 */
import { getDb } from './connection.js';

export interface PrThread {
  channel_id: string;
  thread_ts: string;
  channel_type: string;
  repo_full_name: string;
  pr_number: number;
  session_id: string;
  created_at: string;
}

export function createPrThread(row: PrThread): void {
  getDb()
    .prepare(
      `INSERT INTO pr_threads (channel_id, thread_ts, channel_type, repo_full_name, pr_number, session_id, created_at)
       VALUES (@channel_id, @thread_ts, @channel_type, @repo_full_name, @pr_number, @session_id, @created_at)`,
    )
    .run(row);
}

export function getPrThread(channelId: string, threadTs: string): PrThread | undefined {
  return getDb().prepare('SELECT * FROM pr_threads WHERE channel_id = ? AND thread_ts = ?').get(channelId, threadTs) as
    | PrThread
    | undefined;
}

export function getPrThreadByRepoPr(repoFullName: string, prNumber: number): PrThread | undefined {
  return getDb()
    .prepare('SELECT * FROM pr_threads WHERE repo_full_name = ? AND pr_number = ?')
    .get(repoFullName, prNumber) as PrThread | undefined;
}

export function getPrThreadBySession(sessionId: string): PrThread | undefined {
  return getDb().prepare('SELECT * FROM pr_threads WHERE session_id = ?').get(sessionId) as PrThread | undefined;
}

export function updatePrThreadSession(channelId: string, threadTs: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE pr_threads SET session_id = ? WHERE channel_id = ? AND thread_ts = ?')
    .run(sessionId, channelId, threadTs);
}

export function deletePrThread(channelId: string, threadTs: string): void {
  getDb().prepare('DELETE FROM pr_threads WHERE channel_id = ? AND thread_ts = ?').run(channelId, threadTs);
}
