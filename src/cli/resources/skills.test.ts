/**
 * Tests for `ncl skills` — the group skills-directory reader + the guarded
 * export/add file-map seam that powers the Slack-home team library.
 *
 * Load-bearing behaviors:
 *   1. list distinguishes shared (symlink) from personal (real dir) and
 *      parses the SKILL.md description.
 *   2. export → add round-trips a personal skill between groups; shared
 *      skills are refused on both sides.
 *   3. The add boundary is zero-trust: traversal segments, oversized
 *      payloads, and shared-name collisions are rejected.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-skills' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-skills';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';

// Side-effect import: registers the `skills` resource.
import './skills.js';

const GROUP = 'ag-skills';
const OTHER = 'ag-skills-other';

function skillsDir(group: string): string {
  return path.join(TEST_DIR, 'v2-sessions', group, '.claude-shared', 'skills');
}

function seedPersonalSkill(group: string, name: string, description: string): void {
  const dir = path.join(skillsDir(group), name);
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`,
  );
  fs.writeFileSync(path.join(dir, 'references', 'notes.md'), 'supporting notes\n');
}

function seedSharedSymlink(group: string, name: string): void {
  fs.mkdirSync(skillsDir(group), { recursive: true });
  // Target is a container path — dangling on the host, exactly like production.
  fs.symlinkSync(`/app/skills/${name}`, path.join(skillsDir(group), name));
}

async function run(verb: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await dispatch({ id: `req-${Math.random()}`, command: `skills-${verb}`, args }, { caller: 'host' });
  expect(resp.ok).toBe(true);
  if (!resp.ok) throw new Error('unreachable');
  return resp.data as Record<string, unknown>;
}

async function runExpectingError(verb: string, args: Record<string, unknown>): Promise<string> {
  const resp = await dispatch({ id: `req-${Math.random()}`, command: `skills-${verb}`, args }, { caller: 'host' });
  expect(resp.ok).toBe(false);
  return resp.ok ? '' : (resp.error?.message ?? '');
}

describe('skills CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: GROUP,
      name: 'sdr',
      folder: 'sdr',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await createAgentGroup({
      id: OTHER,
      name: 'cs',
      folder: 'cs',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('list distinguishes shared symlinks from personal dirs and reads descriptions', async () => {
    seedPersonalSkill(GROUP, 'prospect-brief', 'Build a prospect brief');
    seedSharedSymlink(GROUP, 'onecli-gateway');

    const data = await run('list', { group: GROUP });
    expect(data.skills).toEqual([
      { name: 'onecli-gateway', kind: 'shared', description: '' },
      { name: 'prospect-brief', kind: 'personal', description: 'Build a prospect brief' },
    ]);
  });

  it('export → add round-trips a personal skill into another group', async () => {
    seedPersonalSkill(GROUP, 'prospect-brief', 'Build a prospect brief');

    const exported = (await run('export', { group: GROUP, name: 'prospect-brief' })) as {
      files: Record<string, string>;
      description: string;
    };
    expect(Object.keys(exported.files).sort()).toEqual(['SKILL.md', 'references/notes.md']);
    expect(exported.description).toBe('Build a prospect brief');

    const added = await run('add', { group: OTHER, name: 'prospect-brief', files: JSON.stringify(exported.files) });
    expect(added).toMatchObject({ added: 'prospect-brief', files: 2 });

    const list = (await run('list', { group: OTHER })) as { skills: { name: string; kind: string }[] };
    expect(list.skills).toEqual([{ name: 'prospect-brief', kind: 'personal', description: 'Build a prospect brief' }]);
    expect(fs.readFileSync(path.join(skillsDir(OTHER), 'prospect-brief', 'references', 'notes.md'), 'utf8')).toBe(
      'supporting notes\n',
    );
  });

  it('shared skills are refused: export of a symlink, add onto a shared name', async () => {
    seedSharedSymlink(GROUP, 'onecli-gateway');
    expect(await runExpectingError('export', { group: GROUP, name: 'onecli-gateway' })).toContain('shared built-in');
    expect(
      await runExpectingError('add', {
        group: GROUP,
        name: 'onecli-gateway',
        files: JSON.stringify({ 'SKILL.md': 'x' }),
      }),
    ).toContain('collides');
  });

  it('add is zero-trust: traversal, bad names, missing SKILL.md, oversize', async () => {
    expect(
      await runExpectingError('add', {
        group: GROUP,
        name: 'evil',
        files: JSON.stringify({ 'SKILL.md': 'x', '../escape.md': 'y' }),
      }),
    ).toContain('invalid path segment');

    expect(
      await runExpectingError('add', { group: GROUP, name: '../up', files: JSON.stringify({ 'SKILL.md': 'x' }) }),
    ).toContain('invalid skill name');

    expect(
      await runExpectingError('add', { group: GROUP, name: 'noskillmd', files: JSON.stringify({ 'notes.md': 'x' }) }),
    ).toContain('SKILL.md');

    expect(
      await runExpectingError('add', {
        group: GROUP,
        name: 'big',
        files: JSON.stringify({ 'SKILL.md': 'a'.repeat(300 * 1024) }),
      }),
    ).toContain('exceeds');

    // Nothing partial was written by any refused add.
    expect(fs.existsSync(path.join(skillsDir(GROUP), 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir(GROUP), 'big'))).toBe(false);
  });
});
