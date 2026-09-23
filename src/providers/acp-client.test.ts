import { describe, it, expect, vi, beforeEach } from 'vitest';

type ConfigCallback = (ctx: { agentGroupId: string; hostEnv: Record<string, string> }) => {
  env: Record<string, string>;
};

// vi.hoisted runs in the hoisted scope so the reference is available when vi.mock factories run
const captured = vi.hoisted(() => ({ callback: null as ConfigCallback | null }));

vi.mock('../db/agent-groups.js', () => ({ getAgentGroup: vi.fn() }));
vi.mock('../config.js', () => ({ GROUPS_DIR: '/groups' }));
vi.mock('./provider-container-registry.js', () => ({
  registerProviderContainerConfig: vi.fn((_name: string, cb: ConfigCallback) => {
    captured.callback = cb;
  }),
}));
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
  },
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT');
  }),
}));

// Import module — triggers registerProviderContainerConfig side-effect
import './acp-client.js';
import { getAgentGroup } from '../db/agent-groups.js';
import fs from 'fs';

const ctx = (hostEnv: Record<string, string> = {}, agentGroupId = 'grp-1') => ({
  agentGroupId,
  hostEnv,
});

beforeEach(() => {
  vi.mocked(getAgentGroup).mockReturnValue(undefined as any);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error('ENOENT');
  });
});

describe('acp-client host-side container config', () => {
  it('registers with provider name "acp-client"', async () => {
    const { registerProviderContainerConfig } = await import('./provider-container-registry.js');
    expect(vi.mocked(registerProviderContainerConfig)).toHaveBeenCalledWith('acp-client', expect.any(Function));
  });

  it('injects ACP_CLIENT_CMD from env when no group config', () => {
    const env = captured.callback!(ctx({ ACP_CLIENT_CMD: '["my-agent","--flag"]' })).env;
    expect(env.ACP_CLIENT_CMD).toBe('["my-agent","--flag"]');
  });

  it('injects ACP_CLIENT_HOST and ACP_CLIENT_PORT from env when no group config', () => {
    const env = captured.callback!(ctx({ ACP_CLIENT_HOST: 'localhost', ACP_CLIENT_PORT: '7777' })).env;
    expect(env.ACP_CLIENT_HOST).toBe('localhost');
    expect(env.ACP_CLIENT_PORT).toBe('7777');
  });

  it('injects empty env when no config and no env vars', () => {
    const env = captured.callback!(ctx({})).env;
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('adds NO_PROXY for host to bypass OneCLI proxy', () => {
    const env = captured.callback!(ctx({ ACP_CLIENT_HOST: 'localhost', ACP_CLIENT_PORT: '7777' })).env;
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toContain('localhost');
  });

  it('appends to existing NO_PROXY rather than overwriting', () => {
    const env = captured.callback!(ctx({ ACP_CLIENT_HOST: 'myhost', NO_PROXY: '172.17.0.1' })).env;
    expect(env.NO_PROXY).toBe('172.17.0.1,myhost');
  });

  it('does not add NO_PROXY in subprocess mode (no host)', () => {
    const env = captured.callback!(ctx({ ACP_CLIENT_CMD: '["agent"]' })).env;
    expect(env.NO_PROXY).toBeUndefined();
  });
});

describe('acp-client host-side: group config (acp-client.json)', () => {
  it('uses command from group config over env var', () => {
    vi.mocked(getAgentGroup).mockReturnValue({ folder: 'my-group' } as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ command: ['group-agent', '--mode', 'fast'] }) as any);

    const env = captured.callback!(ctx({ ACP_CLIENT_CMD: '["env-agent"]' })).env;
    expect(env.ACP_CLIENT_CMD).toBe(JSON.stringify(['group-agent', '--mode', 'fast']));
  });

  it('uses host+port from group config over env var', () => {
    vi.mocked(getAgentGroup).mockReturnValue({ folder: 'grp' } as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ host: 'group-host', port: 9999 }) as any);

    const env = captured.callback!(ctx({ ACP_CLIENT_HOST: 'env-host', ACP_CLIENT_PORT: '1111' })).env;
    expect(env.ACP_CLIENT_HOST).toBe('group-host');
    expect(env.ACP_CLIENT_PORT).toBe('9999');
  });

  it('falls back to env vars when group config file is missing', () => {
    vi.mocked(getAgentGroup).mockReturnValue({ folder: 'grp' } as any);
    // fs.readFileSync throws by default (see beforeEach)

    const env = captured.callback!(ctx({ ACP_CLIENT_HOST: 'fallback', ACP_CLIENT_PORT: '5555' })).env;
    expect(env.ACP_CLIENT_HOST).toBe('fallback');
    expect(env.ACP_CLIENT_PORT).toBe('5555');
  });
});
