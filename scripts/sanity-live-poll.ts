/**
 * Cross-mount visibility regression test for the two-DB session architecture.
 *
 * What this catches: any change that breaks host→container write propagation
 * across the Docker bind mount. The v2 session DB design relies on three
 * invariants working together:
 *
 *   1. journal_mode = DELETE on every session DB (not WAL)
 *   2. Host opens-writes-closes the DB file on every write
 *   3. One writer per file (inbound = host, outbound = container)
 *
 * This script exercises a long-lived container-side reader polling a DB
 * while the host writes. If visibility is working, the reader sees each
 * write within one poll period. If any of the invariants regresses, the
 * reader either sees nothing, sees only the first write, or sees updates
 * only after the host closes its connection for good.
 *
 * Expected passing output (DELETE mode, close-per-write):
 *   reader sees each seq within ~1s of it being written.
 * Anything else is a regression — investigate BEFORE assuming it's flaky.
 *
 * Keep this around. It ran for ~20 minutes once to map the failure modes
 * and it takes about 60s to run — cheap insurance.
 *
 * Requires: Docker Desktop running, nanoclaw-agent:latest image built.
 */

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

const dbDir = join('/tmp', `nanoclaw-live-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
spawnSync('chmod', ['777', dbDir]);
const dbPath = join(dbDir, 'live.db');

for (const journalMode of ['DELETE', 'WAL']) {
  console.log(`\n=== ${journalMode} ===`);
  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });
  rmSync(dbPath + '-journal', { force: true });

  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${journalMode}`);
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE msgs (seq INTEGER PRIMARY KEY, content TEXT)');
  db.close();

  // Start container poller in background
  const contProc = spawn(
    'docker',
    [
      'run',
      '--rm',
      '-w',
      '/app',
      '-v',
      `${dbDir}:/workspace`,
      '--entrypoint',
      'node',
      'nanoclaw-agent:latest',
      '-e',
      `const Database = require('better-sqlite3');
     const db = new Database('/workspace/live.db', { readonly: true });
     db.pragma('busy_timeout = 2000');
     const stmt = db.prepare('SELECT COUNT(*) as n, MAX(seq) as hi FROM msgs');
     let count = 0;
     const timer = setInterval(() => {
       const r = stmt.get();
       console.log('poll t=' + (Date.now() % 100000) + ' count=' + r.n + ' max=' + r.hi);
       if (++count >= 10) { clearInterval(timer); db.close(); }
     }, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  contProc.stdout.on('data', (d) => process.stdout.write(`  [cont] ${d}`));
  contProc.stderr.on('data', (d) => process.stderr.write(`  [cont-err] ${d}`));

  // Give container a moment to start
  const waitUntil = Date.now() + 2000;
  while (Date.now() < waitUntil) {}

  // Host opens, writes, CLOSES each time (matches production session-manager pattern)
  for (let i = 1; i <= 8; i++) {
    const h = new Database(dbPath);
    h.pragma(`journal_mode = ${journalMode}`);
    h.pragma('synchronous = FULL');
    h.prepare('INSERT INTO msgs (seq, content) VALUES (?, ?)').run(i, `msg-${i}`);
    h.close();
    console.log(`  [host] wrote+closed seq=${i} t=${Date.now() % 100000}`);
    const sleepUntil = Date.now() + 1000;
    while (Date.now() < sleepUntil) {}
  }

  // Wait for container to finish
  await new Promise<void>((res) => contProc.once('exit', () => res()));
}

rmSync(dbDir, { recursive: true, force: true });
