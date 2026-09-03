import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOutboundConnection } from './connection.js';

// A sibling process (standing in for e.g. an MCP server holding a write
// transaction) that opens the same file, takes an EXCLUSIVE lock, prints
// "locked" once it has it, holds the lock briefly, then releases it.
const HOLDER_SCRIPT = `
  const { Database } = await import('bun:sqlite');
  const db = new Database(process.argv[1]);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN EXCLUSIVE');
  db.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
  console.log('locked');
  await new Promise((r) => setTimeout(r, 300));
  db.exec('COMMIT');
  console.log('released');
`;

async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`sibling process exited before printing "${needle}". Output so far: ${buf}`);
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) return;
    }
  } finally {
    reader.releaseLock();
  }
}

describe('openOutboundConnection PRAGMA order', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('waits out a sibling holding an EXCLUSIVE lock instead of failing SQLITE_BUSY on open', async () => {
    dir = mkdtempSync(join(tmpdir(), `nanoclaw-outbound-pragma-${randomUUID()}-`));
    const dbPath = join(dir, 'outbound.db');

    const holder = Bun.spawn({
      cmd: ['bun', '-e', HOLDER_SCRIPT, dbPath],
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      // Don't open our connection until the sibling actually holds the lock.
      await waitForLine(holder.stdout, 'locked');

      const start = Date.now();
      const db = openOutboundConnection(dbPath);
      const elapsed = Date.now() - start;

      // busy_timeout is set before journal_mode, so the open blocks and
      // retries through the sibling's ~300ms hold instead of throwing
      // "database is locked" immediately (which the buggy order does in
      // ~1ms — see the swapped-order regression this guards against).
      expect(elapsed).toBeGreaterThan(150);
      expect(elapsed).toBeLessThan(5000);

      // The connection is fully usable afterward.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_state'").get()).toBeTruthy();
      db.close();
    } finally {
      await holder.exited;
    }
  });
});
