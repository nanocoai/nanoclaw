import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../config.js', async (original) => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-'));
  return {
    ...(await original<typeof import('../config.js')>()),
    DATA_DIR: fixture.root,
    GROUPS_DIR: path.join(fixture.root, 'groups'),
  };
});
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
import './index.js';
import '../provider-contracts/index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { buildMounts } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { initGroupFilesystem } from '../group-init.js';
import type { AgentGroup, Session } from '../types.js';

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
  it('realizes each declared document and state mount exactly once through core', async () => {
    const group = {
      id: 'mount-test',
      name: 'OpenCode',
      folder: 'mount-test',
      agent_provider: 'opencode',
      created_at: new Date().toISOString(),
    } as AgentGroup;
    const session = { id: 'mount-session', agent_group_id: group.id } as Session;
    const groupDir = path.join(fixture.root, 'groups', group.folder);
    const sessionDir = path.join(fixture.root, 'v2-sessions', group.id, session.id);
    await runMigrations(await initTestDb());
    try {
      await createAgentGroup(group);
      await ensureContainerConfig(group.id, 'opencode');
      await initGroupFilesystem(group, { provider: 'opencode' });
      const contribution = await getProviderContainerConfig('opencode')!({
        ...context(),
        agentGroupId: group.id,
        groupDir,
        sessionDir,
      });
      expect(contribution.mounts).toEqual([]);
      expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(false);
      const mounts = await buildMounts(
        group,
        session,
        { provider: 'opencode', mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] },
        'opencode',
        contribution,
      );
      const surfacePaths = ['/workspace/agent/CLAUDE.md', '/home/node/.claude', '/opencode-xdg'];
      expect(
        mounts
          .filter((mount) => surfacePaths.includes(mount.containerPath))
          .map(({ hostPath, containerPath, readonly }) => ({ hostPath, containerPath, readonly })),
      ).toEqual([
        { hostPath: path.join(groupDir, 'CLAUDE.md'), containerPath: '/workspace/agent/CLAUDE.md', readonly: true },
        {
          hostPath: path.join(fixture.root, 'v2-sessions', group.id, '.claude-shared'),
          containerPath: '/home/node/.claude',
          readonly: false,
        },
        { hostPath: path.join(sessionDir, 'opencode-xdg'), containerPath: '/opencode-xdg', readonly: false },
      ]);
      expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'v2-sessions', group.id, '.claude-shared', 'settings.json'))).toBe(
        true,
      );
    } finally {
      await closeDb();
    }
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
