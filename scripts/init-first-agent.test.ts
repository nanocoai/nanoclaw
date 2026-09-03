/**
 * scripts/init-first-agent.ts --instance: the DM row is created for that
 * exact adapter instance and the welcome is addressed to it.
 *
 * What breaks without it: wiring a second Telegram bot (registry key
 * telegram-mega) lands on the default bot's messaging_groups row and the
 * welcome goes out through the default bot.
 * Kill condition: drop `args.instance` from createMessagingGroup (the row's
 * instance falls back to 'telegram'), or from the getMessagingGroupByPlatform
 * lookups (the seeded-default case reuses the default row instead of creating
 * its own), or `instance: dmMg.instance` from the socket payload
 * (to.instance vanishes), or the URL-safe check in parseArgs (a key with a
 * space is accepted and stored).
 *
 * Drives the real entry point in a child process against a temp cwd
 * (PROJECT_ROOT = cwd, so data/v2.db and data/cli.sock are temp) with a fake
 * CLI socket standing in for the running service. Same shape as
 * scripts/migrate.test.ts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'init-first-agent.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

interface MgRow {
  channel_type: string;
  platform_id: string;
  instance: string;
}

describe('scripts/init-first-agent.ts --instance', () => {
  let cwd: string;
  let server: net.Server;
  let nextWelcome: ((line: { to: Record<string, unknown> }) => void) | null = null;
  /** Resolves with the next JSON line the script writes to the CLI socket. */
  const welcome = () =>
    new Promise<{ to: Record<string, unknown> }>((resolve) => {
      nextWelcome = resolve;
    });

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ifa-'));
    fs.mkdirSync(path.join(cwd, 'data'));
    server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      socket.on('end', () => nextWelcome?.(JSON.parse(buf.trim())));
    });
    await new Promise<void>((resolve) => server.listen(path.join(cwd, 'data', 'cli.sock'), resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(extra: string[]): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const args = [
        '--import',
        TSX_LOADER,
        SCRIPT,
        '--channel',
        'telegram',
        '--user-id',
        'telegram:42',
        '--platform-id',
        'telegram:42',
        '--display-name',
        'Amit',
        ...extra,
      ];
      const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  function messagingGroups(): MgRow[] {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return db
        .prepare('SELECT channel_type, platform_id, instance FROM messaging_groups ORDER BY instance')
        .all() as MgRow[];
    } finally {
      db.close();
    }
  }

  it('creates the DM row for the named instance and addresses the welcome to it', async () => {
    const w = welcome();
    const r = await run(['--instance', 'telegram-mega']);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram-mega' },
    ]);
    expect((await w).to).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:42',
      threadId: 'telegram:42',
      instance: 'telegram-mega',
    });
  }, 60_000);

  it('without --instance keeps the default-instance row (instance = channel_type)', async () => {
    const w = welcome();
    const r = await run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([{ channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram' }]);
    expect((await w).to).toMatchObject({ platformId: 'telegram:42', instance: 'telegram' });
  }, 60_000);

  // The same chat paired on the default bot and on a named bot: two rows,
  // the default row untouched, the second welcome through the named bot.
  it('with the default-instance row already present, --instance creates its own exact row and addresses the welcome to it', async () => {
    const w1 = welcome();
    expect((await run([])).status).toBe(0); // bot #1 already wired
    await w1;
    const w2 = welcome();
    const r = await run(['--instance', 'telegram-mega']);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram' },
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram-mega' },
    ]);
    expect((await w2).to).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:42',
      threadId: 'telegram:42',
      instance: 'telegram-mega',
    });
  }, 90_000);

  it('rejects an --instance that is not a URL-safe registry key before touching the DB', async () => {
    const r = await run(['--instance', 'telegram mega']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--instance must be a URL-safe adapter registry key');
    expect(fs.existsSync(path.join(cwd, 'data', 'v2.db'))).toBe(false);
  }, 60_000);
});
