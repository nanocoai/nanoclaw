import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { inboundDbPath, RECURRENCE } from '../lib/inbound-paths.js';
import { nextLocal9am } from '../lib/next-local-9am.js';
import { resolveNanoclawRoot } from '../lib/nanoclaw-root.js';
import { DAILY_NEWS_SCRIPT, resolveTaskPrompt } from '../lib/task-prompt.js';

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findExistingPendingTask(
  db: Database.Database,
  recurrence: string,
  script: string,
): string | null {
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE kind = 'task' AND status = 'pending' AND recurrence = ?",
    )
    .all(recurrence) as Array<{ id: string; content: string }>;

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content) as { script?: string | null };
      if (parsed.script === script) {
        return row.id;
      }
    } catch {
      // ignore malformed content
    }
  }

  return null;
}

async function main(): Promise<void> {
  const nanoclawRoot = resolveNanoclawRoot();
  const dbPath = inboundDbPath(nanoclawRoot);

  if (!fs.existsSync(dbPath)) {
    console.error(`FAIL:inbound.db not found at ${dbPath}`);
    process.exit(1);
  }

  const { insertTask } = await import(
    pathToFileURL(path.join(nanoclawRoot, 'src/modules/scheduling/db.js')).href
  );

  const prompt = resolveTaskPrompt(nanoclawRoot);
  const processAfter = nextLocal9am(new Date());
  const db = new Database(dbPath);

  try {
    const existingId = findExistingPendingTask(db, RECURRENCE, DAILY_NEWS_SCRIPT);
    if (existingId) {
      console.log(`SKIPPED:existing=${existingId}`);
      return;
    }

    const taskId = generateTaskId();
    insertTask(db, {
      id: taskId,
      processAfter,
      recurrence: RECURRENCE,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt, script: DAILY_NEWS_SCRIPT }),
    });

    console.log(`OK:inserted=${taskId},processAfter=${processAfter}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
