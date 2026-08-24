import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

async function seed(ag: AgentGroup): Promise<void> {
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
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

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', async () => {
    const ag = group('ag-persona', 'persona-group');
    await seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    await composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', async () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    await seed(ag);
    writePersona(ag.folder, 'persona body');

    await composeGroupClaudeMd(ag);
    await composeGroupClaudeMd(ag);

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', async () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    await seed(ag);

    await composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions (ncl tasks reach-in)', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion at the
  // module-fragment loop: the agent is taught `ncl tasks` iff it has ncl.
  it('imports module-scheduling.md at the default cli_scope', async () => {
    const ag = group('ag-sched', 'sched-group');
    await seed(ag);

    await composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/module-scheduling.md');
  });

  it('excludes module-scheduling.md (and module-cli.md) when cli_scope is disabled', async () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    await seed(ag);
    await updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    await composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
  });
});
