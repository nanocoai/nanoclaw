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
 * DELETE mode is the assertion: the reader must observe all 8 writes, and the
 * script exits non-zero if it does not. WAL mode runs afterwards purely as a
 * contrast case and is never asserted on — `-shm` is memory-mapped, and
 * whether a host write propagates depends on the mount driver (it does not
 * under VirtioFS/Colima/Lima; it may under a plain Linux bind mount). Read the
 * WAL section as information about this machine, not as a pass or a fail.
 *
 * Keep this around. It ran for ~20 minutes once to map the failure modes
 * and it takes about 60s to run — cheap insurance.
 *
 * The reader mirrors production's `getInboundDb()` (container/agent-runner/
 * src/mailbox/sqlite/connection.ts): read-only, busy_timeout=5000,
 * mmap_size=0. It also runs under Bun with `bun:sqlite`, like the real runner —
 * the agent image ships no `better-sqlite3`, so the previous Node-based reader
 * could not have worked even with the right image name.
 *
 * Requires: Docker running, and this checkout's agent image built
 * (`./container/build.sh`). The tag is per-install; see src/install-slug.ts.
 *
 * Usage: pnpm exec tsx scripts/sanity-live-poll.ts
 */

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

import { CONTAINER_IMAGE } from '../src/config.js';

const WRITES = 8;
const POLLS = 10;

// Fail early and legibly rather than emitting a docker "pull access denied"
// per journal mode after a full minute of host writes. The old hard-coded
// hard-coded shared tag predates per-install image names, so every run of this
// script has been silently vacuous: the host wrote, no container ever read, and
// the script still exited 0.
const inspect = spawnSync('docker', ['image', 'inspect', CONTAINER_IMAGE], { stdio: 'ignore' });
if (inspect.status !== 0) {
  console.error(`✗ Agent image not found: ${CONTAINER_IMAGE}`);
  console.error('  Build it with ./container/build.sh (the tag is per-checkout — see src/install-slug.ts).');
  process.exit(1);
}
console.log(`Using image: ${CONTAINER_IMAGE}`);

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

const dbDir = join('/tmp', `nanoclaw-live-${Date.now()}`);
mkdirSync(dbDir, { recursive: true });
spawnSync('chmod', ['777', dbDir]);
const dbPath = join(dbDir, 'live.db');

// The container-side reader: same pragmas as the real agent-runner's
// long-lived inbound connection.
const readerSource = `
  import { Database } from 'bun:sqlite';
  const db = new Database('/workspace/live.db', { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  const stmt = db.prepare('SELECT COUNT(*) as n, MAX(seq) as hi FROM msgs');
  let count = 0;
  const timer = setInterval(() => {
    const r = stmt.get();
    console.log('poll t=' + (Date.now() % 100000) + ' count=' + r.n + ' max=' + r.hi);
    if (++count >= ${POLLS}) { clearInterval(timer); db.close(); }
  }, 1000);
`;

/** Highest `max=` the container reported, or 0 if it reported nothing. */
async function runMode(journalMode: 'DELETE' | 'WAL'): Promise<number> {
  console.log(`\n=== ${journalMode} ===`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(dbPath + suffix, { force: true });
  }

  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${journalMode}`);
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE msgs (seq INTEGER PRIMARY KEY, content TEXT)');
  db.close();
  spawnSync('chmod', ['666', dbPath]);

  let observed = 0;
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
      'bun',
      CONTAINER_IMAGE,
      '-e',
      readerSource,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  contProc.stdout.on('data', (d: Buffer) => {
    const text = d.toString();
    process.stdout.write(`  [cont] ${text}`);
    for (const m of text.matchAll(/max=(\d+)/g)) {
      observed = Math.max(observed, Number(m[1]));
    }
  });
  contProc.stderr.on('data', (d: Buffer) => process.stderr.write(`  [cont-err] ${d}`));

  // Give the container a moment to start.
  await sleep(2000);

  // Host opens, writes, CLOSES each time (matches production session-manager pattern)
  for (let i = 1; i <= WRITES; i++) {
    const h = new Database(dbPath);
    h.pragma(`journal_mode = ${journalMode}`);
    h.pragma('synchronous = FULL');
    h.prepare('INSERT INTO msgs (seq, content) VALUES (?, ?)').run(i, `msg-${i}`);
    h.close();
    console.log(`  [host] wrote+closed seq=${i} t=${Date.now() % 100000}`);
    await sleep(1000);
  }

  await new Promise<void>((res) => contProc.once('exit', () => res()));
  console.log(`  → reader's highest observed seq: ${observed || 'none'} (host wrote ${WRITES})`);
  return observed;
}

const deleteObserved = await runMode('DELETE');
const walObserved = await runMode('WAL');

rmSync(dbDir, { recursive: true, force: true });

console.log('\n=== Verdict ===');
console.log(`  WAL (contrast only, not asserted): reader saw seq ${walObserved || 'none'} of ${WRITES}`);

if (deleteObserved < WRITES) {
  console.error(
    `✗ REGRESSION: in DELETE mode the container reader saw only seq ${deleteObserved || 'none'} of ${WRITES}. ` +
      'Host→container visibility is broken — investigate BEFORE assuming this is flaky. ' +
      'Start with the pragma block in container/agent-runner/src/mailbox/sqlite/connection.ts ' +
      'and the open-write-close pattern in src/session-manager.ts.',
  );
  process.exit(1);
}

console.log(`✓ DELETE mode: reader observed all ${WRITES} host writes within one poll period each.`);
process.exit(0);
