import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', async (original) => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-'));
  return { ...(await original<typeof import('../config.js')>()), DATA_DIR: fixture.root };
});
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
import './index.js';
import '../provider-contracts/index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';

afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
function context(hostEnv: NodeJS.ProcessEnv = {}) {
  return {
    sessionDir: path.join(fixture.root, 'session'),
    groupDir: path.join(fixture.root, 'group'),
    agentGroupId: 'test',
    selectedSkills: [],
    hostEnv,
    coreOwnsProviderSurfaces: true as const,
  };
}
describe('OpenCode host payload', () => {
  it('keeps the installed CLI and SDK on the same supported exact pin', () => {
    const tools = JSON.parse(fs.readFileSync(new URL('../../container/cli-tools.json', import.meta.url), 'utf8'));
    const runner = JSON.parse(
      fs.readFileSync(new URL('../../container/agent-runner/package.json', import.meta.url), 'utf8'),
    );
    expect(tools.find((entry: { name: string }) => entry.name === 'opencode-ai')).toMatchObject({
      version: '1.18.25',
      onlyBuilt: true,
    });
    expect(runner.dependencies['@opencode-ai/sdk']).toBe('1.18.25');
  });
  it('registers the implementation and version 1 surfaces through the actual barrels', () => {
    expect(getProviderContainerConfig('opencode')).toBeTypeOf('function');
    expect(getProviderHostContract('opencode')).toMatchObject({
      seamVersion: 1,
    });
  });
  it('passes backend defaults and preserves proxy exclusions without doing core filesystem work', async () => {
    const contribution = await getProviderContainerConfig('opencode')!(
      context({
        OPENCODE_PROVIDER: 'openai',
        OPENCODE_MODEL: 'openai/test-model',
        NO_PROXY: 'internal.example',
        no_proxy: 'lower.example',
        ANTHROPIC_BASE_URL: 'http://localhost:8891/v1',
      }),
    );
    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'openai/test-model',
      NO_PROXY: 'internal.example,127.0.0.1,localhost',
      no_proxy: 'lower.example,127.0.0.1,localhost',
    });
    expect(contribution.mounts).toEqual([]);
    expect(fs.existsSync(context().sessionDir)).toBe(false);
  });
  it('selects ChatGPT mode without requiring or mounting any host auth file', async () => {
    const contribution = await getProviderContainerConfig('opencode')!(context({ OPENCODE_AUTH_MODE: 'chatgpt' }));
    expect(contribution.env).toMatchObject({ OPENCODE_AUTH_MODE: 'chatgpt' });
    expect(contribution.mounts).toEqual([]);
    expect(fs.existsSync(context().sessionDir)).toBe(false);
    const api = await getProviderContainerConfig('opencode')!(context());
    expect(api.env).toMatchObject({ OPENCODE_AUTH_MODE: 'api-key' });
  });
});
