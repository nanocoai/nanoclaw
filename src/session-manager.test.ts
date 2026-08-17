/**
 * Tests for session-manager's session-folder lifecycle paths.
 *
 * (The former writeOutboundDirect suite is gone with the function: the host
 * never writes messages_out, and never writes outbound.db while a container
 * may be running — command-gate denials go through the delivery adapter (see
 * router.deny-notice.test.ts); host-sweep's post-container processing_ack
 * cleanup via openOutboundDbRw remains the one sanctioned host write.)
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from './session-manager.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
const AG = 'ag-test';
const SESS = 'sess-test';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/**
 * The `/debug` skill tells operators to `rm -rf` a session folder to reset a
 * stuck session. The sessions row survives, so the next message takes the
 * existing-session path and lands in `writeSessionMessage` with a missing
 * inbound.db. Without re-provisioning, better-sqlite3 throws on open and the
 * message is logged-and-dropped forever — the reset silently kills the chat.
 */
describe('writeSessionMessage re-provisions a deleted session folder', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
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
    createSession(sess);
  });

  afterEach(() => {
    closeDb();
  });

  it('re-creates the folder + inbound.db and does not throw when the row still exists', () => {
    // Operator resets a stuck session by deleting its folder; the row survives.
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(false);

    expect(() =>
      writeSessionMessage(AG, SESS, {
        id: 'after-reset-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ text: 'still here?' }),
      }),
    ).not.toThrow();

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
