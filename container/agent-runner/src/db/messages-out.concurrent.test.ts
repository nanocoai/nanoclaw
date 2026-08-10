import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function createSessionDbs(): { inboundPath: string; outboundPath: string } {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-delivery-claim-'));
  const inboundPath = path.join(tempDir, 'inbound.db');
  const outboundPath = path.join(tempDir, 'outbound.db');

  const inbound = new Database(inboundPath);
  inbound.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER UNIQUE);
  `);
  inbound.close();

  const outbound = new Database(outboundPath);
  outbound.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT,
      timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT,
      kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT,
      thread_id TEXT, content TEXT NOT NULL
    );
  `);
  outbound.close();
  return { inboundPath, outboundPath };
}

async function workerResult(
  id: string,
  paths: { inboundPath: string; outboundPath: string },
): Promise<{ id: string; seq: number; inserted: boolean }> {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, 'messages-out.concurrent-worker.ts'), id], {
    env: {
      ...process.env,
      NANOCLAW_INBOUND_DB_PATH: paths.inboundPath,
      NANOCLAW_OUTBOUND_DB_PATH: paths.outboundPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`worker ${id} failed: ${stderr}`);
  return JSON.parse(stdout) as { id: string; seq: number; inserted: boolean };
}

describe('turn-scoped claims across the MCP process boundary', () => {
  it('commits one outbound row when two processes race for the same delivery', async () => {
    const paths = createSessionDbs();
    const [mcp, final] = await Promise.all([workerResult('mcp-process', paths), workerResult('final-process', paths)]);

    expect([mcp.inserted, final.inserted].sort()).toEqual([false, true]);
    expect(mcp.seq).toBe(final.seq);
    expect(mcp.id).toBe(final.id);

    const outbound = new Database(paths.outboundPath, { readonly: true });
    const counts = outbound
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages_out) AS messages,
           (SELECT COUNT(*) FROM message_delivery_claims) AS claims`,
      )
      .get() as { messages: number; claims: number };
    outbound.close();
    expect(counts).toEqual({ messages: 1, claims: 1 });
  });
});
