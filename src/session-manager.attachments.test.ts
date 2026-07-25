/**
 * Security regression for the channel-inbound attachment path (#2828 sibling).
 *
 * `extractAttachmentFiles` (via `writeSessionMessage`) hardens the per-message
 * inbox subdir against pre-placed symlinks, but NOT the `inbox` root itself.
 * A compromised container can write inside its own session dir, so it can
 * replace `inbox` with a symlink pointing outside the session sandbox. The
 * existing guard then:
 *   - skips the lstat branch (it only lstats `inbox/<msgId>`, not `inbox`),
 *   - mkdirs `inbox/<msgId>` *through* the symlink,
 *   - passes the containment check, because it compares against
 *     `realpathSync(inboxRoot)` which has already followed the symlink, and
 *   - writes a brand-new file (the `wx` flag only blocks an existing dst).
 *
 * Result: the host writes attacker-influenced bytes outside the session root —
 * the same class of bug fixed for the A2A path in forwardAttachedFiles (#2828).
 *
 * This test asserts the SECURE behaviour (nothing written outside). It FAILS
 * against the current code, demonstrating the gap.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-saveatt-gap' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { openInboundDb } from './db/session-db.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
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

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', () => {
    // Attacker-controlled location outside the session sandbox.
    const canaryDir = path.join(TEST_DIR, 'canary-outside');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Container pre-places its whole `inbox` as a symlink pointing outside.
    const inboxRoot = path.join(sessionDir(AG, SESS), 'inbox');
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, inboxRoot);

    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'pwn.txt', data: Buffer.from('attacker-bytes').toString('base64') }],
    });

    writeSessionMessage(AG, SESS, {
      id: 'evil-inbox-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    // SECURE expectation: nothing was written through the symlink to the
    // attacker-controlled canary location.
    const escaped = path.join(canaryDir, 'evil-inbox-root', 'pwn.txt');
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });
});

describe('extractAttachmentFiles — scoped message ids keep colon-free inbox dirs', () => {
  // Message ids can carry a per-agent scope suffix (`<id>:ag-<groupId>`).
  // A colon inside the inbox path segment breaks downstream consumers that
  // parse `path:line` (agent read tools) or split mount specs on `:` (docker
  // CLI). The id itself must stay untouched; only the directory name is
  // sanitized. Seen live on 2026-07-25: an agent reported an uploaded file
  // missing while it sat readable in its container, because its read tool
  // split the metadata path at the colon.
  it('writes the attachment under a sanitized dir and points localPath at it', () => {
    const scopedId = 'web-1784959140240-i:ag-6e9d6f1b-77e1-4cbf-b86c-e9fd062a2c19';
    const content = JSON.stringify({
      text: 'md upload',
      attachments: [{ name: 'plan.md', mimeType: 'text/plain', data: Buffer.from('# plan\n').toString('base64') }],
    });

    writeSessionMessage(AG, SESS, {
      id: scopedId,
      kind: 'chat',
      timestamp: now(),
      platformId: 'web:local',
      channelType: 'web',
      threadId: null,
      content,
    });

    const sanitized = scopedId.replace(/:/g, '-');
    const written = path.join(sessionDir(AG, SESS), 'inbox', sanitized, 'plan.md');
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf8')).toBe('# plan\n');

    const inboxEntries = fs.readdirSync(path.join(sessionDir(AG, SESS), 'inbox'));
    for (const entry of inboxEntries) expect(entry.includes(':')).toBe(false);

    const db = openInboundDb(path.join(sessionDir(AG, SESS), 'inbound.db'));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(scopedId) as
      | { content: string }
      | undefined;
    db.close();
    expect(row).toBeDefined();
    const att = JSON.parse(row!.content).attachments[0];
    expect(att.localPath).toBe(`inbox/${sanitized}/plan.md`);
    expect(att.localPath.includes(':')).toBe(false);
  });

  it('leaves an already-clean message id byte-for-byte unchanged', () => {
    const cleanId = 'web-1784959140240-0';
    const content = JSON.stringify({
      text: 'clean id',
      attachments: [{ name: 'a.md', mimeType: 'text/plain', data: Buffer.from('a\n').toString('base64') }],
    });
    writeSessionMessage(AG, SESS, {
      id: cleanId,
      kind: 'chat',
      timestamp: now(),
      platformId: 'web:local',
      channelType: 'web',
      threadId: null,
      content,
    });
    expect(fs.existsSync(path.join(sessionDir(AG, SESS), 'inbox', cleanId, 'a.md'))).toBe(true);
  });

  it('sanitizes the whole consumer-hostile class, not just one colon', () => {
    const uglyId = 'id:with:many colons and spaces';
    const content = JSON.stringify({
      text: 'ugly id',
      attachments: [{ name: 'b.md', mimeType: 'text/plain', data: Buffer.from('b\n').toString('base64') }],
    });
    writeSessionMessage(AG, SESS, {
      id: uglyId,
      kind: 'chat',
      timestamp: now(),
      platformId: 'web:local',
      channelType: 'web',
      threadId: null,
      content,
    });
    const dir = 'id-with-many-colons-and-spaces';
    expect(fs.existsSync(path.join(sessionDir(AG, SESS), 'inbox', dir, 'b.md'))).toBe(true);
  });

  it('sanitizes attachment FILENAMES carrying the same class', () => {
    const id = 'web-1784959140240-1';
    const content = JSON.stringify({
      text: 'colon filename',
      attachments: [{ name: 'foo:bar.md', mimeType: 'text/plain', data: Buffer.from('fb\n').toString('base64') }],
    });
    writeSessionMessage(AG, SESS, {
      id,
      kind: 'chat',
      timestamp: now(),
      platformId: 'web:local',
      channelType: 'web',
      threadId: null,
      content,
    });
    const written = path.join(sessionDir(AG, SESS), 'inbox', id, 'foo-bar.md');
    expect(fs.existsSync(written)).toBe(true);
    const db2 = openInboundDb(path.join(sessionDir(AG, SESS), 'inbound.db'));
    const row2 = db2.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string };
    db2.close();
    const att2 = JSON.parse(row2.content).attachments[0];
    expect(att2.name).toBe('foo-bar.md');
    expect(att2.localPath).toBe(`inbox/${id}/foo-bar.md`);
  });
});
