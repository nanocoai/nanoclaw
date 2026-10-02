import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-provider-env-test';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-claude-provider-env-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-claude-provider-env-test/groups',
}));

const dotenv = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(keys.flatMap((k) => (k in dotenv.values ? [[k, dotenv.values[k]]] : []))),
}));

import { realizeProviderSpawnSurfaces } from '../provider-contracts/realize.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import '../provider-contracts/index.js';
import './index.js';

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const previous = process.env[KEY];

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
  dotenv.values = {};
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// Mirrors resolveProviderContribution for a declared contract, minus the
// DB-backed project-doc compose.
async function claudeEnv(): Promise<Record<string, string> | undefined> {
  const fn = getProviderContainerConfig('claude');
  const groupDir = `${TEST_ROOT}/groups/claude-env`;
  const sessionDir = `${TEST_ROOT}/data/v2-sessions/group-1/session-1`;
  fs.mkdirSync(groupDir, { recursive: true });
  const ctx = { sessionDir, agentGroupId: 'group-1', groupDir, selectedSkills: [], hostEnv: process.env };
  const surfaces = await realizeProviderSpawnSurfaces(
    'claude',
    getProviderHostContract('claude')!,
    'group-1',
    groupDir,
    sessionDir,
    [],
    {
      legacyOverlay: async () => (await fn?.({ ...ctx, coreOwnsProviderSurfaces: true })) ?? {},
      composeProjectDocument: async () => {},
    },
  );
  return surfaces.contribution.env;
}

describe('claude provider container env', () => {
  it('passes CLAUDE_CODE_AUTO_COMPACT_WINDOW from the host env into the container', async () => {
    process.env[KEY] = '900000';
    expect((await claudeEnv())?.[KEY]).toBe('900000');
  });

  it('falls back to .env when the service env does not carry it', async () => {
    delete process.env[KEY];
    dotenv.values = { [KEY]: '500000' };
    expect((await claudeEnv())?.[KEY]).toBe('500000');
  });

  it('contributes nothing when unset, leaving the in-container default', async () => {
    delete process.env[KEY];
    expect((await claudeEnv())?.[KEY]).toBeUndefined();
  });

  it('drops a non-numeric value instead of passing it through', async () => {
    process.env[KEY] = '1m';
    expect((await claudeEnv())?.[KEY]).toBeUndefined();
  });
});
