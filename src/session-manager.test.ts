/**
 * Tests for session-manager's direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` entry against a real session folder
 * on disk. A previous implementation opened the outbound DB through
 * `openOutboundDb` (readonly: true), so every INSERT threw SQLITE_READONLY
 * and the command-gate denial path silently never delivered. Goes red if the
 * open call reverts to the readonly form.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import {
  destroySessionMailbox,
  initSessionFolder,
  sessionContextPath,
  sessionDir,
  withMailboxSession,
  writeOutboundDirect,
  writeSessionContext,
  writeSessionMessage,
} from './session-manager.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
const AG = 'ag-test';
const SESS = 'sess-test';

function readMessagesOut(): Array<{ id: string; seq: number; kind: string; content: string }> {
  const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT id, seq, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      kind: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('withMailboxSession', () => {
  it('rejects same-key nesting and allows different keys', async () => {
    await expect(withMailboxSession(AG, SESS, () => withMailboxSession(AG, SESS, () => undefined))).rejects.toThrow(
      `Nested mailbox session for ${AG}/${SESS}`,
    );

    await expect(
      withMailboxSession(AG, SESS, () => withMailboxSession(AG, `${SESS}-other`, () => undefined)),
    ).resolves.toBeUndefined();
  });

  it('destroys only mailbox-owned files', async () => {
    const workspaceFile = path.join(sessionDir(AG, SESS), 'workspace.txt');
    fs.writeFileSync(workspaceFile, 'keep');

    await destroySessionMailbox(AG, SESS);

    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(false);
    expect(fs.existsSync(outboundDbPath(AG, SESS))).toBe(false);
    expect(fs.readFileSync(workspaceFile, 'utf8')).toBe('keep');
  });
});

describe('writeSessionContext', () => {
  it('writes from a host-owned path even if the agent plants the old session path', () => {
    const plantedPath = path.join(sessionDir(AG, SESS), '.nanoclaw-session.json');
    const victimPath = path.join(TEST_DIR, 'victim.json');
    fs.writeFileSync(victimPath, 'unchanged');
    fs.symlinkSync(victimPath, plantedPath);

    writeSessionContext(AG, SESS, { implementation: 'test' });

    const contextPath = sessionContextPath(AG, SESS);
    expect(contextPath.startsWith(`${sessionDir(AG, SESS)}${path.sep}`)).toBe(false);
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('unchanged');
    expect(fs.lstatSync(plantedPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(contextPath, 'utf8'))).toEqual({
      agentGroupId: AG,
      sessionId: SESS,
      mailbox: { implementation: 'test' },
    });
    expect(fs.statSync(contextPath).mode & 0o777).toBe(0o600);
  });
});

describe('writeOutboundDirect', () => {
  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', async () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    await writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'Admin commands are restricted.' }),
    });

    const rows = readMessagesOut();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('denial-1');
    expect(rows[0].seq).toBe(2);
    expect(rows[0].seq % 2).toBe(0); // host uses even seq numbers
    expect(JSON.parse(rows[0].content).text).toBe('Admin commands are restricted.');
  });

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', async () => {
    await writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    await writeOutboundDirect(AG, SESS, {
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    await writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"retry"}',
    });

    const rows = readMessagesOut();
    expect(rows.map((r) => r.id)).toEqual(['denial-1', 'denial-2']);
    expect(rows.map((r) => r.seq)).toEqual([2, 4]);
  });

  it('allocates even sequences per file — inbound writes never read outbound.db', async () => {
    // Sequences are per-file (matching v1): host inbound seqs scan only
    // messages_in, direct outbound seqs scan only messages_out. A shared
    // cross-file space would make every router insert read the
    // container-owned outbound.db across the mount — the lock coupling the
    // two-DB split exists to prevent. Parity (host even / runner odd) is the
    // only cross-file invariant.
    const insert = (id: string) =>
      withMailboxSession(AG, SESS, (mailbox) =>
        mailbox.insertMessage({
          id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: null,
          channelType: null,
          threadId: null,
          content: '{}',
          processAfter: null,
          recurrence: null,
        }),
      );
    await insert('in-1');
    await writeOutboundDirect(AG, SESS, {
      id: 'out-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
    });
    await insert('in-2');

    const inbound = new Database(inboundDbPath(AG, SESS), { readonly: true });
    const inboundSeq = inbound.prepare('SELECT seq FROM messages_in ORDER BY seq').all() as Array<{ seq: number }>;
    inbound.close();
    expect(inboundSeq.map(({ seq }) => seq)).toEqual([2, 4]);
    expect(readMessagesOut().map(({ seq }) => seq)).toEqual([2]);
  });
});

/**
 * The `/debug` skill tells operators to `rm -rf` a session folder to reset a
 * stuck session. The sessions row survives, so the next message takes the
 * existing-session path and lands in `writeSessionMessage` with a missing
 * inbound.db. Without re-provisioning, better-sqlite3 throws on open and the
 * message is logged-and-dropped forever — the reset silently kills the chat.
 */
describe('writeSessionMessage re-provisions a deleted session folder', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: AG,
      name: 'Reset',
      folder: 'reset',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const sess: Session = {
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    await createSession(sess);
  });

  afterEach(async () => {
    await closeDb();
  });

  it('re-creates the folder + inbound.db and does not throw when the row still exists', async () => {
    // Operator resets a stuck session by deleting its folder; the row survives.
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(false);

    await expect(
      writeSessionMessage(AG, SESS, {
        id: 'after-reset-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ text: 'still here?' }),
      }),
    ).resolves.toBeUndefined();

    // The folder + inbound.db are back and the message landed.
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(true);
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT id, content FROM messages_in WHERE id = ?').get('after-reset-1') as
        | { id: string; content: string }
        | undefined;
      expect(row?.id).toBe('after-reset-1');
      expect(JSON.parse(row!.content).text).toBe('still here?');
    } finally {
      db.close();
    }
  });
});
