import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-backfill-container-configs-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-backfill-container-configs-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-backfill-container-configs-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { closeDb, createAgentGroup, getContainerConfig, initTestDb, runMigrations } from './db/index.js';
import { log } from './log.js';

const LEGACY = { mcpServers: { tool: { command: 'tool-server' } }, imageTag: 'legacy-tag', packages: { apt: ['jq'] } };

async function legacyGroup(folder: string): Promise<string> {
  await createAgentGroup({
    id: `ag-${folder}`,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups', folder), { recursive: true });
  return path.join(TEST_ROOT, 'groups', folder, 'container.json');
}

function expectDefaults(row: Awaited<ReturnType<typeof getContainerConfig>>): void {
  expect(row).toBeDefined();
  expect(row!.image_tag).toBeNull();
  expect(JSON.parse(row!.mcp_servers)).toEqual({});
  expect(JSON.parse(row!.packages_apt)).toEqual([]);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('backfillContainerConfigs legacy container.json', () => {
  it('imports a regular legacy file', async () => {
    const file = await legacyGroup('plain');
    fs.writeFileSync(file, JSON.stringify(LEGACY));

    await backfillContainerConfigs();

    const row = await getContainerConfig('ag-plain');
    expect(row!.image_tag).toBe('legacy-tag');
    expect(JSON.parse(row!.mcp_servers)).toEqual(LEGACY.mcpServers);
    expect(JSON.parse(row!.packages_apt)).toEqual(['jq']);
  });

  it('creates a default row when the group has no legacy file', async () => {
    await legacyGroup('absent');
    await backfillContainerConfigs();
    expectDefaults(await getContainerConfig('ag-absent'));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not follow a symlinked container.json', async () => {
    const file = await legacyGroup('linked');
    const outside = path.join(TEST_ROOT, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(LEGACY));
    fs.symlinkSync(outside, file);

    await backfillContainerConfigs();

    expectDefaults(await getContainerConfig('ag-linked'));
    expect(log.warn).toHaveBeenCalled();
  });

  it('does not read a FIFO planted as container.json', async () => {
    const file = await legacyGroup('fifo');
    execFileSync('mkfifo', [file]);
    // A writer is waiting, so a path-based read would get these fields.
    const writer = spawn('sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(LEGACY), file], {
      stdio: 'ignore',
    });
    try {
      await backfillContainerConfigs();
    } finally {
      writer.kill();
    }

    expectDefaults(await getContainerConfig('ag-fifo'));
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps file content out of the parse warning', async () => {
    const bad = await legacyGroup('bad');
    fs.writeFileSync(bad, 'secret-looking-text');

    await backfillContainerConfigs();

    expectDefaults(await getContainerConfig('ag-bad'));
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('secret-looking');
  });

  it('tolerates non-object JSON without crashing startup', async () => {
    const nil = await legacyGroup('nil');
    fs.writeFileSync(nil, 'null');

    await backfillContainerConfigs();

    expectDefaults(await getContainerConfig('ag-nil'));
  });
});
