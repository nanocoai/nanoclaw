/**
 * Install-wide model defaults: NANOCLAW_DEFAULT_MODEL and NANOCLAW_FAST_MODE.
 *
 * Both are resolved when the host materializes container.json, so the assertion
 * that matters is what `configFromDb` puts in the file. Neither may appear in
 * it when unset — an install that sets nothing must produce byte-identical
 * config to the one it produced before these existed.
 *
 * `config.ts` reads process.env at import, so each case re-imports the module
 * graph with the environment it is testing rather than mocking the constants.
 * That exercises the real resolution chain.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-model',
  name: 'model',
  folder: 'model',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

/** Re-import container-config with a given environment and run configFromDb. */
async function withEnv(env: Record<string, string | undefined>, row: ContainerConfigRow): Promise<ContainerConfig> {
  const saved: Record<string, string | undefined> = {};
  const savedCwd = process.cwd();
  const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-model-defaults-'));
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    process.chdir(emptyProject);
    vi.resetModules();
    const { configFromDb } = await import('./container-config.js');
    return configFromDb(row, GROUP);
  } finally {
    process.chdir(savedCwd);
    fs.rmSync(emptyProject, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR = { NANOCLAW_DEFAULT_MODEL: undefined, NANOCLAW_FAST_MODE: undefined };

describe('install-wide model defaults', () => {
  let row: ContainerConfigRow;

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);
    row = (await getContainerConfig(GROUP.id))!;
  });

  afterEach(async () => {
    await closeDb();
    vi.resetModules();
  });

  it('ships neither field when neither variable is set', async () => {
    const cfg = await withEnv(CLEAR, row);
    expect(cfg.model).toBeUndefined();
    expect(cfg.speed).toBeUndefined();
  });

  it('fills the model for a group that has none', async () => {
    const cfg = await withEnv({ ...CLEAR, NANOCLAW_DEFAULT_MODEL: 'claude-sonnet-5' }, row);
    expect(cfg.model).toBe('claude-sonnet-5');
  });

  it("never overrides the group's own model", async () => {
    await updateContainerConfigScalars(GROUP.id, { model: 'claude-opus-5' });
    const withModel = (await getContainerConfig(GROUP.id))!;
    const cfg = await withEnv({ ...CLEAR, NANOCLAW_DEFAULT_MODEL: 'claude-sonnet-5' }, withModel);
    expect(cfg.model).toBe('claude-opus-5');
  });

  it('treats an empty default as unset rather than shipping an empty model', async () => {
    const cfg = await withEnv({ ...CLEAR, NANOCLAW_DEFAULT_MODEL: '' }, row);
    expect(cfg.model).toBeUndefined();
  });

  it("enables fast mode on '1' and 'true', case-insensitively", async () => {
    for (const value of ['1', 'true', 'TRUE', 'True']) {
      expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: value }, row)).speed).toBe('fast');
    }
  });

  it('leaves fast mode off for anything else — a typo must not start charging', async () => {
    for (const value of ['0', 'false', 'yes', 'on', 'ture', '']) {
      expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: value }, row)).speed).toBeUndefined();
    }
  });

  it("keeps the group's fast speed when the install default is off", async () => {
    await updateContainerConfigScalars(GROUP.id, { speed: 'fast' });
    const withSpeed = (await getContainerConfig(GROUP.id))!;
    expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: 'false' }, withSpeed)).speed).toBe('fast');
  });

  it("lets the group's standard speed override the install-wide fast default", async () => {
    await updateContainerConfigScalars(GROUP.id, { speed: 'standard' });
    const withSpeed = (await getContainerConfig(GROUP.id))!;
    expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: 'true' }, withSpeed)).speed).toBe('standard');
  });

  // container.json is read by whatever agent image is installed. An image
  // built before `speed` existed reads only `fastMode`, so the file must keep
  // carrying it — and an install that sets nothing must keep getting the file
  // it always got.
  describe('container.json compatibility with agent images built before `speed`', () => {
    const jsonKeys = (cfg: ContainerConfig): string[] => Object.keys(JSON.parse(JSON.stringify(cfg)));

    it('writes neither speed nor fastMode when nothing is set', async () => {
      const cfg = await withEnv(CLEAR, row);
      expect(jsonKeys(cfg)).not.toContain('speed');
      expect(jsonKeys(cfg)).not.toContain('fastMode');
      expect(Object.keys(cfg)).not.toContain('fastMode');
    });

    it('writes the legacy fastMode key next to speed when fast comes from the install default', async () => {
      const unset = jsonKeys(await withEnv(CLEAR, row));
      const cfg = await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: 'true' }, row);
      const keys = jsonKeys(cfg);
      expect(cfg.fastMode).toBe(true);
      expect(cfg.speed).toBe('fast');
      // Same file as before, plus the two keys where `fastMode` always sat.
      expect(keys.filter((key) => key !== 'fastMode' && key !== 'speed')).toEqual(unset);
      expect(keys.indexOf('speed')).toBe(keys.indexOf('fastMode') + 1);
      expect(keys.indexOf('fastMode')).toBeGreaterThan(keys.indexOf('maxMessagesPerPrompt'));
    });

    it('writes the legacy fastMode key when fast comes from the group', async () => {
      await updateContainerConfigScalars(GROUP.id, { speed: 'fast' });
      const cfg = await withEnv(CLEAR, (await getContainerConfig(GROUP.id))!);
      expect(cfg.fastMode).toBe(true);
      expect(cfg.speed).toBe('fast');
    });

    it('writes speed alone for standard, so an old image runs at its default', async () => {
      await updateContainerConfigScalars(GROUP.id, { speed: 'standard' });
      const cfg = await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: 'true' }, (await getContainerConfig(GROUP.id))!);
      expect(cfg.speed).toBe('standard');
      expect(jsonKeys(cfg)).not.toContain('fastMode');
    });
  });
});
