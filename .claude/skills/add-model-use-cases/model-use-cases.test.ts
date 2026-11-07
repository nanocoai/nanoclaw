/**
 * Wiring guard for `/add-model-use-cases`.
 *
 * The integration point is the `model:` line of `configFromDb` in
 * `container-config.ts`, so every case drives `configFromDb` itself: deleting
 * or bypassing the `resolveModelUseCase` call turns these red. Each case
 * re-imports the module graph with the environment under test, from an empty
 * project directory so the checkout's own `.env` cannot leak in.
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
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-use-case',
  name: 'use-case',
  folder: 'use-case',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

const VARS = ['NANOCLAW_DEFAULT_MODEL', 'NANOCLAW_USE_CASE_MODEL_CODING', 'NANOCLAW_USE_CASE_MODEL_DEEP_THINK'];

async function configFor(model: string | null, env: Record<string, string>, dotEnv = ''): Promise<ContainerConfig> {
  await updateContainerConfigScalars(GROUP.id, { model });
  const row = (await getContainerConfig(GROUP.id))!;
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-use-case-'));
  if (dotEnv) fs.writeFileSync(path.join(project, '.env'), dotEnv);
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    process.chdir(project);
    vi.resetModules();
    const { configFromDb } = await import('./container-config.js');
    return configFromDb(row, GROUP);
  } finally {
    process.chdir(savedCwd);
    fs.rmSync(project, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('configFromDb resolves model use cases', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);
  });

  afterEach(async () => {
    await closeDb();
    vi.resetModules();
  });

  it('resolves a use case from the process environment', async () => {
    const cfg = await configFor('usecase:coding', { NANOCLAW_USE_CASE_MODEL_CODING: 'claude-opus-5' });
    expect(cfg.model).toBe('claude-opus-5');
  });

  it('resolves a use case from .env', async () => {
    const cfg = await configFor('usecase:deep-think', {}, 'NANOCLAW_USE_CASE_MODEL_DEEP_THINK=claude-sonnet-5\n');
    expect(cfg.model).toBe('claude-sonnet-5');
  });

  it('resolves a use case set as the install default model', async () => {
    const cfg = await configFor(null, {
      NANOCLAW_DEFAULT_MODEL: 'usecase:coding',
      NANOCLAW_USE_CASE_MODEL_CODING: 'claude-opus-5',
    });
    expect(cfg.model).toBe('claude-opus-5');
  });

  it('never sends an unconfigured token to the provider', async () => {
    const cfg = await configFor('usecase:coding', {});
    expect(cfg.model).toBeUndefined();
  });

  it('passes a plain model through unchanged', async () => {
    const cfg = await configFor('claude-haiku-5', { NANOCLAW_USE_CASE_MODEL_CODING: 'claude-opus-5' });
    expect(cfg.model).toBe('claude-haiku-5');
  });
});
