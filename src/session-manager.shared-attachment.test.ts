/**
 * Regression for the WhatsApp-style shared-attachment path.
 *
 * Some channel adapters (WhatsApp's downloadInboundMedia) download inbound
 * files straight to DATA_DIR/attachments/<name> and reference them via
 * `localPath: "attachments/<name>"` instead of inlining base64 `data`. That
 * shared staging dir is never mounted into any container, so the agent was
 * told a path (`/workspace/attachments/<name>`) that didn't exist on its
 * side — every WhatsApp file/image attachment was unreadable. This asserts
 * `extractAttachmentFiles` (via `writeSessionMessage`) copies such files
 * into the session's own inbox, same as the base64 path.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-shared-att' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import { openInboundDb } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-shared-att';
const AG = 'ag-sharedatt';
const SESS = 'sess-sharedatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'attachments'), { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'SharedAtt', folder: 'sharedatt', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('extractAttachmentFiles — WhatsApp-style shared attachment copy', () => {
  it('copies a localPath-referenced file from DATA_DIR/attachments into the session inbox', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'attachments', 'STOCK167726.xlsx'), 'fake-xlsx-bytes');

    const content = JSON.stringify({
      text: 'stock file',
      attachments: [{ type: 'document', name: 'STOCK167726.xlsx', localPath: 'attachments/STOCK167726.xlsx' }],
    });

    writeSessionMessage(AG, SESS, {
      id: 'msg-shared-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    const expectedCopy = path.join(sessionDir(AG, SESS), 'inbox', 'msg-shared-1', 'STOCK167726.xlsx');
    expect(fs.existsSync(expectedCopy)).toBe(true);
    expect(fs.readFileSync(expectedCopy, 'utf8')).toBe('fake-xlsx-bytes');

    const db = openInboundDb(AG, SESS);
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-shared-1') as {
        content: string;
      };
      const stored = JSON.parse(row.content);
      expect(stored.attachments[0].localPath).toBe('inbox/msg-shared-1/STOCK167726.xlsx');
    } finally {
      db.close();
    }
  });

  it('does not overwrite an existing inbox file, and skips missing sources without throwing', () => {
    const missingContent = JSON.stringify({
      text: 'no file here',
      attachments: [{ type: 'document', name: 'ghost.xlsx', localPath: 'attachments/ghost.xlsx' }],
    });

    expect(() =>
      writeSessionMessage(AG, SESS, {
        id: 'msg-shared-missing',
        kind: 'chat',
        timestamp: now(),
        platformId: 'whatsapp:123',
        channelType: 'whatsapp',
        threadId: null,
        content: missingContent,
      }),
    ).not.toThrow();

    const shouldNotExist = path.join(sessionDir(AG, SESS), 'inbox', 'msg-shared-missing', 'ghost.xlsx');
    expect(fs.existsSync(shouldNotExist)).toBe(false);
  });
});
