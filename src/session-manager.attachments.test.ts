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
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
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
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/**
 * Let the container win the race: run `swap` once, right before the host's
 * first fs call that creates `leaf`. Every way the host could create the file
 * goes through one of these calls, so the swap lands after every check.
 */
function swapBeforeCreate(leaf: string, swap: () => void): void {
  let fired = false;
  for (const method of ['openSync', 'writeFileSync', 'copyFileSync'] as const) {
    const original = fs[method] as (...args: unknown[]) => unknown;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = method === 'copyFileSync' ? args[1] : args[0];
      if (!fired && typeof target === 'string' && path.basename(target) === leaf) {
        fired = true;
        swap();
      }
      return original.apply(fs, args);
    }) as never);
  }
}

/** Replace inbox/<messageId> with a symlink to `target`, as a container could. */
function swapInboxDir(messageId: string, target: string): () => void {
  return () => {
    const dir = path.join(sessionDir(AG, SESS), 'inbox', messageId);
    fs.renameSync(dir, `${dir}-moved`);
    fs.symlinkSync(target, dir);
  };
}

function attachmentMessage(id: string, names: string[]) {
  return {
    id,
    kind: 'chat' as const,
    timestamp: now(),
    platformId: 'whatsapp:123',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({
      text: 'see attached',
      attachments: names.map((name) => ({ name, data: Buffer.from(`bytes-${name}`).toString('base64') })),
    }),
  };
}

describe('extractAttachmentFiles — inbox dir swapped after the checks', () => {
  it('writes a single attachment into the directory it checked', async () => {
    const canaryDir = path.join(TEST_DIR, 'canary-single');
    fs.mkdirSync(canaryDir, { recursive: true });
    swapBeforeCreate('one.txt', swapInboxDir('race-single', canaryDir));

    await writeSessionMessage(AG, SESS, attachmentMessage('race-single', ['one.txt']));

    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });

  it('writes every attachment of a batch into the directory it checked', async () => {
    const canaryDir = path.join(TEST_DIR, 'canary-batch');
    fs.mkdirSync(canaryDir, { recursive: true });
    swapBeforeCreate('second.txt', swapInboxDir('race-batch', canaryDir));

    await writeSessionMessage(AG, SESS, attachmentMessage('race-batch', ['first.txt', 'second.txt']));

    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });

  it('still saves attachments when nothing interferes', async () => {
    await writeSessionMessage(AG, SESS, attachmentMessage('plain', ['a.txt', 'b.txt']));

    const inbox = path.join(sessionDir(AG, SESS), 'inbox', 'plain');
    expect(fs.readFileSync(path.join(inbox, 'a.txt'), 'utf-8')).toBe('bytes-a.txt');
    expect(fs.readFileSync(path.join(inbox, 'b.txt'), 'utf-8')).toBe('bytes-b.txt');
  });
});

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', async () => {
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

    await writeSessionMessage(AG, SESS, {
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
