/**
 * A4 — folder-reuse refusal (plan-review security finding "immutable
 * identity").
 *
 * `ncl groups delete` never removes `groups/<folder>/` (declared contract of
 * the delete handler), so a folder on disk with no claiming DB row is
 * deleted-group residue or an operator-placed dir. Minting a NEW agent-group
 * id over it would silently adopt the old group's data (memory, skills,
 * CLAUDE.md) under a new identity. The fresh-create branch of
 * `ncl groups create` must refuse; idempotent reuse of a LIVE folder's group
 * (DB row exists) is untouched.
 *
 * Separate file from groups.test.ts on purpose: this suite must mock
 * GROUPS_DIR (groups.test.ts mocks only DATA_DIR — create-path tests added
 * there would write into the real repo groups/ during test runs).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-groups-create-folder-reuse/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-groups-create-folder-reuse/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-groups-create-folder-reuse';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including create).
import './groups.js';

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function create(folder: string) {
  return dispatch(
    {
      id: `req-create-${folder}-${Math.random().toString(36).slice(2, 8)}`,
      command: 'groups-create',
      args: { folder },
    },
    { caller: 'host' },
  );
}

describe('groups-create — folder-reuse refusal (A4)', () => {
  it('refuses to mint a new group over undisposed on-disk residue', async () => {
    // Deleted-group residue: the folder is on disk, no DB row claims it.
    fs.mkdirSync(path.join(GROUPS_DIR, 'recycled'));
    fs.writeFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'old group memory\n');

    const resp = await create('recycled');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { message: string } }).error;
    expect(error.message).toContain('already exists on disk');
    expect(error.message).toContain('recycled');
    // No row minted, residue untouched.
    expect(await getDb().get('SELECT * FROM agent_groups WHERE folder = ?', 'recycled')).toBeUndefined();
    expect(fs.readFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'utf8')).toBe('old group memory\n');
  });

  it('refuses when the residue is a dangling symlink at groups/<folder>', async () => {
    // Residue can be a symlink whose target is gone (e.g. an operator linked
    // the folder elsewhere and the target was removed). It still occupies the
    // name — mkdir would EEXIST — so the fresh-create branch must refuse it
    // like any other on-disk presence.
    fs.symlinkSync(path.join(TEST_ROOT, 'no-such-target'), path.join(GROUPS_DIR, 'linked'));

    const resp = await create('linked');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { message: string } }).error;
    expect(error.message).toContain('already exists on disk');
    expect(await getDb().get('SELECT * FROM agent_groups WHERE folder = ?', 'linked')).toBeUndefined();
  });

  it('allows creation when the folder is absent (scaffolds folder + config row)', async () => {
    const resp = await create('fresh');

    expect(resp.ok).toBe(true);
    const row = (await getDb().get<{ id: string }>('SELECT * FROM agent_groups WHERE folder = ?', 'fresh'))!;
    expect(row).toBeDefined();
    expect(fs.existsSync(path.join(GROUPS_DIR, 'fresh'))).toBe(true);
    expect(await getDb().get('SELECT * FROM container_configs WHERE agent_group_id = ?', row.id)).toBeDefined();
  });

  it('returns the SAME group when the folder is live — idempotency on --folder pinned', async () => {
    const first = await create('steady');
    expect(first.ok).toBe(true);
    const firstId = (first as { ok: true; data: { id: string } }).data.id;

    // The folder now exists on disk AND a DB row claims it. The refusal must
    // sit on the fresh-create branch only — a second create with the same
    // --folder returns the existing group, exactly as documented
    // ("Idempotent on --folder").
    const second = await create('steady');
    expect(second.ok).toBe(true);
    expect((second as { ok: true; data: { id: string } }).data.id).toBe(firstId);
  });
});
