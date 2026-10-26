import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-materialize-container-json-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-materialize-container-json-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-materialize-container-json-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { materializeContainerJson } from './container-config.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';

async function group(folder: string): Promise<string> {
  await createAgentGroup({
    id: `ag-${folder}`,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(`ag-${folder}`);
  const dir = path.join(TEST_ROOT, 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'container.json');
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('materializeContainerJson writes the leaf without following links', () => {
  it('creates a real file when none exists', async () => {
    const p = await group('fresh');
    await materializeContainerJson('ag-fresh');
    expect(fs.lstatSync(p).isFile()).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(p, 'utf8'))).not.toThrow();
  });

  it('rewrites an existing regular file in place (same inode)', async () => {
    const p = await group('existing');
    fs.writeFileSync(p, '{"stale":true}\n');
    const inoBefore = fs.statSync(p).ino;

    await materializeContainerJson('ag-existing');

    // Same inode: a running container's bind mount sees the new config live.
    expect(fs.statSync(p).ino).toBe(inoBefore);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).not.toHaveProperty('stale');
  });

  it('replaces a planted symlink instead of writing through it', async () => {
    const p = await group('linked');
    const outside = path.join(TEST_ROOT, 'outside.json');
    fs.writeFileSync(outside, 'precious\n');
    fs.symlinkSync(outside, p);

    await materializeContainerJson('ag-linked');

    expect(fs.readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(p).isFile()).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(p, 'utf8'))).not.toThrow();
  });

  it('replaces a planted FIFO without blocking', async () => {
    const p = await group('fifo');
    execFileSync('mkfifo', [p]);

    await materializeContainerJson('ag-fifo');

    expect(fs.lstatSync(p).isFIFO()).toBe(false);
    expect(fs.lstatSync(p).isFile()).toBe(true);
  });

  it('replaces a FIFO that has a reader (open succeeds, file-type check routes it)', async () => {
    const p = await group('fifo-reader');
    execFileSync('mkfifo', [p]);
    // Hold a reader open so the writer's O_WRONLY|O_NONBLOCK open succeeds and
    // the fstat-not-a-regular-file branch (not the open-error branch) runs.
    const reader = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      await materializeContainerJson('ag-fifo-reader');
    } finally {
      fs.closeSync(reader);
    }

    expect(fs.lstatSync(p).isFIFO()).toBe(false);
    expect(fs.lstatSync(p).isFile()).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(p, 'utf8'))).not.toThrow();
  });

  it('never deletes outside files when container.json is a planted directory', async () => {
    const p = await group('dir');
    const outside = path.join(TEST_ROOT, 'outside-dir');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'canary'), 'keep\n');
    // A directory at the leaf, holding a symlink to the outside dir: a
    // recursive remove could follow it and delete the canary.
    fs.mkdirSync(p);
    fs.symlinkSync(outside, path.join(p, 'child'));

    await expect(materializeContainerJson('ag-dir')).rejects.toThrow();

    expect(fs.existsSync(path.join(outside, 'canary'))).toBe(true);
    expect(fs.lstatSync(p).isDirectory()).toBe(true);
  });
});
