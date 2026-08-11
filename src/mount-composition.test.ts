/**
 * Behavioural tests for the mount table `buildMounts` produces.
 *
 * The mount table is where this codebase decides who may write what: an
 * agent's capabilities are what is mounted into it. Those decisions were
 * previously only assertable by reading the function, so this file pins the
 * properties rather than the source text — what is nested where, in which
 * mode, in what order, and whether the sources exist by the time a spawn would
 * consume them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mounts-'));
const TEST_DATA_DIR = path.join(TMP_ROOT, 'data');
const TEST_GROUPS_DIR = path.join(TMP_ROOT, 'groups');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR, GROUPS_DIR: TEST_GROUPS_DIR };
});

const { buildMounts, orderMounts } = await import('./container-runner.js');
const { initSessionFolder } = await import('./session-manager.js');
const { initGroupFilesystem } = await import('./group-init.js');
const { initTestDb, closeDb, runMigrations, createAgentGroup } = await import('./db/index.js');
const { materializeContainerJson } = await import('./container-config.js');

type Mount = { hostPath: string; containerPath: string; readonly: boolean };

const GROUP = {
  id: 'ag-mounts',
  name: 'Mounts',
  folder: 'mounts',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

const SESSION = {
  id: 'sess-mounts',
  agent_group_id: GROUP.id,
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active' as const,
  container_status: 'stopped' as const,
  last_active: null,
  created_at: new Date().toISOString(),
};

function compose(): Mount[] {
  // Same call the spawn path makes — the config is materialized from the DB
  // row `initGroupFilesystem` stamped.
  const config = materializeContainerJson(GROUP.id);
  return buildMounts(GROUP, SESSION, config, 'claude', {}) as Mount[];
}

/** The mount whose target is exactly `containerPath`. */
function at(mounts: Mount[], containerPath: string): Mount | undefined {
  return mounts.find((m) => m.containerPath === containerPath);
}

function depth(p: string): number {
  return p.split('/').filter(Boolean).length;
}

describe('buildMounts composition', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup(GROUP);
    initGroupFilesystem(GROUP);
    initSessionFolder(GROUP.id, SESSION.id);
  });

  afterEach(() => {
    closeDb();
  });

  it('mounts every declared bind source that already exists on disk', () => {
    // The runtime creates a missing bind source itself — as a directory, and
    // on Linux as root — so a source this table names but nobody creates is a
    // spawn that half-works and a session folder this process cannot write.
    for (const mount of compose()) {
      expect(fs.existsSync(mount.hostPath), `missing bind source: ${mount.hostPath}`).toBe(true);
    }
  });

  it('gives the container a read-only view of the directories the host writes', () => {
    const mounts = compose();
    expect(at(mounts, '/workspace/inbox')?.readonly).toBe(true);
    expect(at(mounts, '/workspace/agent/tasks')?.readonly).toBe(true);
    expect(at(mounts, '/workspace/inbound.db')?.readonly).toBe(true);
  });

  it('keeps the surfaces the container legitimately writes writable', () => {
    const mounts = compose();
    expect(at(mounts, '/workspace')?.readonly).toBe(false);
    expect(at(mounts, '/workspace/agent')?.readonly).toBe(false);
    expect(at(mounts, '/workspace/outbox')?.readonly).toBe(false);
    expect(at(mounts, '/workspace/outbound.db')?.readonly).toBe(false);
  });

  it('names each single-writer entry explicitly rather than inheriting the parent mode', () => {
    // Each of these has exactly one writer, so each gets its own entry rather
    // than taking whatever mode the enclosing mount happens to carry.
    const targets = compose().map((m) => m.containerPath);
    expect(targets).toContain('/workspace/inbound.db');
    expect(targets).toContain('/workspace/outbound.db');
    expect(targets).toContain('/workspace/outbox');
  });

  it('emits every nested entry after the entry it nests inside', () => {
    const mounts = compose();
    mounts.forEach((child, childIndex) => {
      mounts.forEach((parent, parentIndex) => {
        if (child === parent) return;
        const nested =
          child.containerPath !== parent.containerPath &&
          child.containerPath.startsWith(`${parent.containerPath.replace(/\/$/, '')}/`);
        if (!nested) return;
        expect(parentIndex, `${parent.containerPath} must be mounted before ${child.containerPath}`).toBeLessThan(
          childIndex,
        );
      });
    });
  });

  it('does not project any host-written directory inside a writable mount without saying so', () => {
    // The property that matters for review: any path the host writes that
    // falls inside a writable mount carries its own entry, so the mount table
    // states each surface's mode rather than leaving it implied.
    const mounts = compose();
    const writable = mounts.filter((m) => !m.readonly);
    const sessDir = path.join(TEST_DATA_DIR, 'v2-sessions', GROUP.id, SESSION.id);
    const groupDir = path.join(TEST_GROUPS_DIR, GROUP.folder);

    const hostWritten = [path.join(sessDir, 'inbox'), path.join(sessDir, 'inbound.db'), path.join(groupDir, 'tasks')];

    for (const target of hostWritten) {
      const covering = writable.filter(
        (m) => target !== m.hostPath && target.startsWith(`${m.hostPath.replace(/\/$/, '')}/`),
      );
      if (covering.length === 0) continue;
      expect(
        mounts.some((m) => m.hostPath === target),
        `${target} sits inside ${covering.map((m) => m.containerPath).join(', ')} without its own entry`,
      ).toBe(true);
    }
  });
});

describe('orderMounts', () => {
  it('sorts parents before children by target depth', () => {
    const ordered = orderMounts([
      { hostPath: '/h/c', containerPath: '/workspace/agent/tasks', readonly: true },
      { hostPath: '/h/a', containerPath: '/workspace', readonly: false },
      { hostPath: '/h/b', containerPath: '/workspace/agent', readonly: false },
    ]);
    expect(ordered.map((m) => m.containerPath)).toEqual(['/workspace', '/workspace/agent', '/workspace/agent/tasks']);
  });

  it('is stable within a depth, so declaration order still decides last-wins', () => {
    const ordered = orderMounts([
      { hostPath: '/h/first', containerPath: '/app/one', readonly: true },
      { hostPath: '/h/second', containerPath: '/app/two', readonly: true },
      { hostPath: '/h/third', containerPath: '/app/three', readonly: true },
    ]);
    expect(ordered.map((m) => m.hostPath)).toEqual(['/h/first', '/h/second', '/h/third']);
  });

  it('never reorders two entries of equal depth', () => {
    const input = [
      { hostPath: '/h/a', containerPath: '/workspace/outbox', readonly: false },
      { hostPath: '/h/b', containerPath: '/workspace/inbox', readonly: true },
    ];
    expect(orderMounts(input).map((m) => m.hostPath)).toEqual(['/h/a', '/h/b']);
    expect(depth('/workspace/outbox')).toBe(depth('/workspace/inbox'));
  });
});

describe('mount-source and allowlist overlap', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup(GROUP);
    initGroupFilesystem(GROUP);
    initSessionFolder(GROUP.id, SESSION.id);
  });
  afterEach(() => closeDb());

  it('refuses to compose a mount whose source is no longer the entry we created', () => {
    const inbox = path.join(TEST_DATA_DIR, 'v2-sessions', GROUP.id, SESSION.id, 'inbox');
    const elsewhere = path.join(TMP_ROOT, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.rmSync(inbox, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, inbox);

    expect(() => compose()).toThrow(/is not the entry we created/);
  });
});
