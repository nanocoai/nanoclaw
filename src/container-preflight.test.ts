import { EventEmitter } from 'events';
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
}));
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-preflight-test',
  GROUPS_DIR: '/tmp/nanoclaw-preflight-test/groups',
}));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({
    id: 'real-group',
    name: 'Test group',
    folder: 'test-group',
    agent_provider: null,
    created_at: '',
  })),
}));
vi.mock('./container-config.js', () => ({
  configFromDb: vi.fn(() => ({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    imageTag: 'test-image',
    additionalMounts: [],
    skills: [],
    provider: 'codex',
    groupName: 'Test group',
    assistantName: 'Test group',
    agentGroupId: 'preflight-id',
    maxMessagesPerPrompt: 10,
    model: 'test-model',
    effort: 'medium',
  })),
}));
vi.mock('./session-manager.js', () => ({
  sessionDir: vi.fn(
    (groupId: string, sessionId: string) => `/tmp/nanoclaw-preflight-test/sessions/${groupId}/${sessionId}`,
  ),
}));
vi.mock('./container-runner.js', () => ({
  buildMounts: vi.fn(() => []),
  buildContainerArgs: vi.fn(async (...args: unknown[]) => ['run', '-c', args.at(-1)]),
  resolveProviderName: vi.fn(() => 'codex'),
}));
vi.mock('./providers/provider-container-registry.js', () => ({ getProviderContainerConfig: vi.fn(() => undefined) }));
vi.mock('./log.js', () => ({ log: { warn: vi.fn() } }));

import { preflightContainerConfig } from './container-preflight.js';
import type { ContainerConfigRow } from './types.js';

const candidate = {} as ContainerConfigRow;

function childProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('container provider preflight lifecycle', () => {
  beforeEach(() => {
    fs.rmSync('/tmp/nanoclaw-preflight-test', { recursive: true, force: true });
    mocks.spawn.mockReset();
    mocks.stopContainer.mockReset();
    mocks.removeContainer.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    fs.rmSync('/tmp/nanoclaw-preflight-test', { recursive: true, force: true });
  });

  it('uses the real credential identity and resolves a successful probe', async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    const promise = preflightContainerConfig('real-group', candidate);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('PREFLIGHT_OK'));
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec bun run /app/src/preflight.ts']),
      expect.anything(),
    );
  });

  it('returns provider/container failures and cleans up', async () => {
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    const promise = preflightContainerConfig('real-group', candidate);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('HTTP 400 unsupported model'));
    child.emit('close', 2);

    await expect(promise).rejects.toThrow(/HTTP 400 unsupported model/);
    expect(fs.readdirSync('/tmp/nanoclaw-preflight-test')).toHaveLength(0);
  });

  it('force-removes a timed-out container before cleanup', async () => {
    vi.useFakeTimers();
    mocks.stopContainer.mockImplementation(() => {
      throw new Error('stop failed');
    });
    const child = childProcess();
    mocks.spawn.mockReturnValue(child);
    const promise = preflightContainerConfig('real-group', candidate);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(120_000);
    child.emit('close', null);

    await expect(promise).rejects.toThrow(/timed out/);
    expect(mocks.removeContainer).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.readdirSync('/tmp/nanoclaw-preflight-test')).toHaveLength(0);
  });
});
