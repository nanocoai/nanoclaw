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

// The DB-backed project-doc compose is not under test here.
vi.mock('../project-doc-compose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../project-doc-compose.js')>()),
  composeGroupProjectDoc: async () => {},
}));

import { resolveProviderContribution } from '../container-runner.js';
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';
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

// The spawn path's own resolution; composeSessionSpec puts contribution.env on
// the contributed lane (container-runner.test.ts).
async function claudeEnv(): Promise<Record<string, string> | undefined> {
  const session = { id: 'session-1', agent_group_id: 'group-1', agent_provider: null } as Session;
  const group = { id: 'group-1', folder: 'claude-env' } as AgentGroup;
  const config: ContainerConfig = {
    provider: 'claude',
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
  };
  fs.mkdirSync(`${TEST_ROOT}/groups/claude-env`, { recursive: true });
  return (await resolveProviderContribution(session, group, config)).contribution.env;
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

  it('treats an empty service value as unset and still reads .env', async () => {
    process.env[KEY] = ' ';
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
