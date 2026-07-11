import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = vi.hoisted(() => '/tmp/nanoclaw-test-temporal-lifecycle');

vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { isContainerRunning, killContainer } from './container-runner.js';
import { closeDb, createAgentGroup, createMessagingGroup, getSession, initTestDb, runMigrations } from './db/index.js';
import { findTemporalSession } from './db/sessions.js';
import { sessionDir } from './session-manager.js';
import { destroyTemporalSession, resolveTemporalSession } from './temporal-session.js';

function now() {
  return new Date().toISOString();
}

describe('temporal-session lifecycle', () => {
  const ag = `ag-${randomUUID()}`;
  const mg = `mg-${randomUUID()}`;

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: ag,
      name: 'Agent',
      folder: `folder-${randomUUID()}`,
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: mg,
      channel_type: 'discord',
      platform_id: `chan-${randomUUID()}`,
      name: 'DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    vi.mocked(isContainerRunning).mockReturnValue(false);
    vi.mocked(killContainer).mockReset();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a temporal=1 session with a folder', () => {
    const { session, created } = resolveTemporalSession(ag, mg, null, 'shared');
    expect(created).toBe(true);
    expect(session.temporal).toBe(1);
    expect(session.messaging_group_id).toBe(mg);
    expect(session.thread_id).toBeNull();
    expect(fs.existsSync(sessionDir(ag, session.id))).toBe(true);
    expect(findTemporalSession(ag, mg, null)?.id).toBe(session.id);
  });

  it('is idempotent — a second resolve reuses the same session', () => {
    const first = resolveTemporalSession(ag, mg, null, 'shared');
    const second = resolveTemporalSession(ag, mg, null, 'shared');
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
  });

  it('destroy (no running container) closes+deletes the row and removes the folder', () => {
    const { session } = resolveTemporalSession(ag, mg, null, 'shared');
    const dir = sessionDir(ag, session.id);
    expect(fs.existsSync(dir)).toBe(true);

    destroyTemporalSession(session);

    expect(killContainer).not.toHaveBeenCalled();
    expect(getSession(session.id)).toBeUndefined();
    expect(findTemporalSession(ag, mg, null)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('destroy (running container) defers cleanup to container exit', () => {
    const { session } = resolveTemporalSession(ag, mg, null, 'shared');
    const dir = sessionDir(ag, session.id);

    vi.mocked(isContainerRunning).mockReturnValue(true);
    let onExit: (() => void) | undefined;
    vi.mocked(killContainer).mockImplementation((_id, _reason, cb) => {
      onExit = cb;
    });

    destroyTemporalSession(session);

    // Cleanup deferred — row + folder still present until the container exits.
    expect(killContainer).toHaveBeenCalledWith(session.id, 'temporal-end', expect.any(Function));
    expect(getSession(session.id)).toBeDefined();
    expect(fs.existsSync(dir)).toBe(true);

    // Simulate the container process closing.
    onExit?.();
    expect(getSession(session.id)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
