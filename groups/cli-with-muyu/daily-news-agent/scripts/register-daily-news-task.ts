import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { inboundDbPath } from '../lib/inbound-paths.js';
import { nextLocal9am } from '../lib/next-local-9am.js';
import { resolveNanoclawRoot } from '../lib/nanoclaw-root.js';
import { registerDailyNewsTask } from '../lib/register-daily-news-task.js';
import { resolveTaskPrompt } from '../lib/task-prompt.js';

async function loadDatabase(nanoclawRoot: string) {
  const modulePath = path.join(nanoclawRoot, 'node_modules/better-sqlite3/lib/index.js');
  const { default: Database } = await import(pathToFileURL(modulePath).href);
  return Database as typeof import('better-sqlite3').default;
}

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const taskId = generateTaskId();
  const Database = await loadDatabase(nanoclawRoot);
  const db = new Database(dbPath);

  try {
    const result = registerDailyNewsTask(db, insertTask, {
      taskId,
      processAfter,
      prompt,
    });

    if (result.status === 'skipped') {
      console.log(`SKIPPED:existing=${result.taskId}`);
      return;
    }

    console.log(`OK:inserted=${result.taskId},processAfter=${processAfter}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
