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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-model',
  name: 'model',
  folder: 'model',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

/** Re-import container-config with a given environment and run configFromDb. */
async function withEnv(
  env: Record<string, string | undefined>,
  row: ContainerConfigRow,
): Promise<{ model?: string; fastMode?: boolean }> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    vi.resetModules();
    const { configFromDb } = await import('./container-config.js');
    const cfg = configFromDb(row, GROUP);
    return { model: cfg.model, fastMode: cfg.fastMode };
  } finally {
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
    expect(cfg.fastMode).toBeUndefined();
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
      expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: value }, row)).fastMode).toBe(true);
    }
  });

  it('leaves fast mode off for anything else — a typo must not start charging', async () => {
    for (const value of ['0', 'false', 'yes', 'on', 'ture', '']) {
      expect((await withEnv({ ...CLEAR, NANOCLAW_FAST_MODE: value }, row)).fastMode).toBeUndefined();
    }
  });
});
