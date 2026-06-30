import fs from 'node:fs';

import Database from 'better-sqlite3';

import { inboundDbPath, RECURRENCE } from '../groups/cli-with-muyu/daily-news-agent/lib/inbound-paths.js';
import { resolveNanoclawRoot } from '../groups/cli-with-muyu/daily-news-agent/lib/nanoclaw-root.js';
import { DAILY_NEWS_SCRIPT } from '../groups/cli-with-muyu/daily-news-agent/lib/task-prompt.js';

interface TaskRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  series_id: string;
}

function main(): void {
  const nanoclawRoot = resolveNanoclawRoot();
  const dbPath = inboundDbPath(nanoclawRoot);

  if (!fs.existsSync(dbPath)) {
    console.error(`FAIL:inbound.db not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db
      .prepare(
        "SELECT id, status, process_after, recurrence, content, series_id FROM messages_in WHERE kind = 'task' AND recurrence = ? ORDER BY timestamp DESC",
      )
      .all(RECURRENCE) as TaskRow[];

    const matching = rows.filter((row) => {
      try {
        const parsed = JSON.parse(row.content) as { script?: string | null };
        return parsed.script === DAILY_NEWS_SCRIPT;
      } catch {
        return false;
      }
    });

    if (matching.length === 0) {
      console.log('NOT_FOUND:no task with recurrence and daily-fetch script');
      process.exit(1);
    }

    for (const row of matching) {
      let script: string | null = null;
      try {
        script = (JSON.parse(row.content) as { script?: string | null }).script ?? null;
      } catch {
        // keep null
      }

      console.log(
        [
          `id=${row.id}`,
          `status=${row.status}`,
          `process_after=${row.process_after ?? 'null'}`,
          `recurrence=${row.recurrence ?? 'null'}`,
          `series_id=${row.series_id}`,
          `script=${script ?? 'null'}`,
        ].join(' '),
      );
    }

    const pending = matching.filter((row) => row.status === 'pending');
    console.log(`SUMMARY:total=${matching.length},pending=${pending.length}`);
  } finally {
    db.close();
  }
}

main();
