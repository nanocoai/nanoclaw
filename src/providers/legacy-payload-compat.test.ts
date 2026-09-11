import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-legacy-provider-compat-test';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-legacy-provider-compat-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-legacy-provider-compat-test/groups',
}));

import { resolveProviderContribution } from '../container-runner.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';
import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

const installed = fs.existsSync(new URL('./opencode.ts', import.meta.url));
const describeLegacy = installed && !getProviderHostContract('opencode') ? describe : describe.skip;
const env = {
  NO_PROXY: 'corp.local',
  no_proxy: 'internal',
  OPENCODE_PROVIDER: 'openrouter',
  OPENCODE_MODEL: 'openrouter/model',
  OPENCODE_SMALL_MODEL: 'openrouter/small',
  ANTHROPIC_BASE_URL: 'https://openrouter.example/v1',
  OPENCODE_MODEL_CONTEXT_LIMIT: '1000',
  OPENCODE_MODEL_OUTPUT_LIMIT: '100',
  OPENCODE_MODEL_INPUT_MODALITIES: 'text,image',
} as const;
const previous = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describeLegacy('pre-contract OpenCode payload on new host core', () => {
  it('runs the real registered legacy contribution exactly once', async () => {
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    expect(listProviderContainerConfigNames()).toContain('opencode');

    const session = { id: 'session-1', agent_group_id: 'group-1', agent_provider: null } as Session;
    const group = { id: 'group-1', folder: 'legacy-opencode' } as AgentGroup;
    const config: ContainerConfig = {
      provider: 'opencode',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const opencodeDir = path.join(TEST_ROOT, 'data/v2-sessions/group-1/session-1/opencode-xdg');
    const mkdir = vi.spyOn(fs, 'mkdirSync');

    const resolved = await resolveProviderContribution(session, group, config);

    expect(resolved.surfaces).toBeUndefined();
    expect(resolved.contribution.mounts).toEqual([
      { hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false },
    ]);
    expect(resolved.contribution.env).toEqual({
      XDG_DATA_HOME: '/opencode-xdg',
      NO_PROXY: 'corp.local,127.0.0.1,localhost',
      no_proxy: 'internal,127.0.0.1,localhost',
      OPENCODE_PROVIDER: 'openrouter',
      OPENCODE_MODEL: 'openrouter/model',
      OPENCODE_SMALL_MODEL: 'openrouter/small',
      ANTHROPIC_BASE_URL: 'https://openrouter.example/v1',
      OPENCODE_MODEL_CONTEXT_LIMIT: '1000',
      OPENCODE_MODEL_OUTPUT_LIMIT: '100',
      OPENCODE_MODEL_INPUT_MODALITIES: 'text,image',
    });
    expect(mkdir.mock.calls.filter(([target]) => target === opencodeDir)).toHaveLength(1);
  });
});
