/**
 * The inbound write path asks for a prompt reconcile once the message is
 * durable — through the feed, so nothing here imports the sweep.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mail-feed' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { registerReconcileEnqueue } from './reconcile-feeds.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-mail-feed';
const AG = 'ag-feed';
const SESS = 'sess-feed';

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Feed',
    folder: 'feed',
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
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  registerReconcileEnqueue(null);
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mail-written reconcile feed', () => {
  it('enqueues the session after the message is durable', async () => {
    const enqueue = vi.fn();
    registerReconcileEnqueue(enqueue);

    await writeSessionMessage(AG, SESS, {
      id: 'm-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'hello' }),
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(SESS);
  });

  it('writes succeed unchanged when no feed is registered', async () => {
    await expect(
      writeSessionMessage(AG, SESS, {
        id: 'm-2',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ text: 'again' }),
      }),
    ).resolves.toBeUndefined();
  });
});
