/**
 * Test fixture: leave a real hot rollback journal beside a SQLite DB, as a
 * container SIGKILLed mid-transaction does. A child process opens the DB in
 * journal_mode=DELETE, forces page spills with a one-page cache so the journal
 * header and pages reach disk, writes inside a transaction, then kills itself
 * before COMMIT. The DB must already have the outbound schema. Throws, with the
 * child's stderr, if the child did not die by SIGKILL or left no journal.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function strandJournal(dbPath: string): void {
  const script = `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma('journal_mode = DELETE');
    db.pragma('cache_size = 1');
    db.exec('BEGIN');
    const insert = db.prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'chat', ?)");
    for (let i = 0; i < 400; i++) insert.run('m' + i, 2 * i + 1, new Date().toISOString(), 'x'.repeat(2000));
    process.kill(process.pid, 'SIGKILL');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
  if (result.signal !== 'SIGKILL' || !fs.existsSync(`${dbPath}-journal`)) {
    throw new Error(
      `strandJournal: writer exited ${result.status ?? result.signal ?? result.error?.message} ` +
        `without leaving a journal: ${result.stderr?.toString().trim() || '(no stderr)'}`,
    );
  }
}
