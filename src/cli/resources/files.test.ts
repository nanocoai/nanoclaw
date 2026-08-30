/**
 * Tests for `ncl files` — whole-workspace list/read/write with the two
 * carve-outs (composer artifacts read-only, dot entries hidden) and the
 * containment guards the Memory tab relies on.
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
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-files/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-files/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-files';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';

// Side-effect import: registers the `files` resource.
import './files.js';

const GROUP = 'ag-files';
const WS = path.join(TEST_DIR, 'groups', 'sdr');

async function run(verb: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await dispatch({ id: `req-${Math.random()}`, command: `files-${verb}`, args }, { caller: 'host' });
  expect(resp.ok).toBe(true);
  if (!resp.ok) throw new Error('unreachable');
  return resp.data as Record<string, unknown>;
}

async function runExpectingError(verb: string, args: Record<string, unknown>): Promise<string> {
  const resp = await dispatch({ id: `req-${Math.random()}`, command: `files-${verb}`, args }, { caller: 'host' });
  expect(resp.ok).toBe(false);
  return resp.ok ? '' : (resp.error?.message ?? '');
}

describe('files CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(WS, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'CLAUDE.local.md'), '# memory\nremember things\n');
    fs.writeFileSync(path.join(WS, 'CLAUDE.md'), 'composed — do not edit\n');
    fs.writeFileSync(path.join(WS, 'container.json'), '{}\n');
    fs.writeFileSync(path.join(WS, 'memory', 'notes.md'), 'note\n');
    fs.mkdirSync(path.join(WS, '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.claude-fragments', 'hidden.md'), 'plumbing\n');

    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: GROUP,
      name: 'sdr',
      folder: 'sdr',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('list shows the workspace with composer artifacts read-only and dot entries hidden', async () => {
    const data = (await run('list', { group: GROUP })) as { entries: Record<string, unknown>[] };
    const names = data.entries.map((e) => e.name);
    expect(names).toEqual(['CLAUDE.local.md', 'CLAUDE.md', 'container.json', 'memory']);
    expect(data.entries.find((e) => e.name === 'CLAUDE.md')).toMatchObject({ readonly: true });
    expect(data.entries.find((e) => e.name === 'CLAUDE.local.md')).toMatchObject({ readonly: false });
    expect(data.entries.find((e) => e.name === 'memory')).toMatchObject({ type: 'dir' });
  });

  it('read + write round-trip an editable file; subdirectory paths work', async () => {
    const read = await run('read', { group: GROUP, path: 'memory/notes.md' });
    expect(read).toMatchObject({ content: 'note\n', readonly: false, truncated: false });

    await run('write', { group: GROUP, path: 'memory/notes.md', content: 'updated note\n' });
    expect(fs.readFileSync(path.join(WS, 'memory', 'notes.md'), 'utf8')).toBe('updated note\n');
  });

  it('write refuses composer artifacts, new files, traversal, and dot paths', async () => {
    expect(await runExpectingError('write', { group: GROUP, path: 'CLAUDE.md', content: 'x' })).toContain('read-only');
    expect(await runExpectingError('write', { group: GROUP, path: 'brand-new.md', content: 'x' })).toContain(
      'not an existing file',
    );
    expect(await runExpectingError('write', { group: GROUP, path: '../escape.md', content: 'x' })).toContain(
      'invalid path segment',
    );
    expect(await runExpectingError('read', { group: GROUP, path: '.claude-fragments/hidden.md' })).toContain(
      'invalid path segment',
    );
    expect(fs.existsSync(path.join(WS, 'brand-new.md'))).toBe(false);
  });
});
