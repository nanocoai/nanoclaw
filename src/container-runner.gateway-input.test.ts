/**
 * A new runtime's gateway input names the agent provider it runs, resolved the
 * same way spawn resolves it, so a gateway that grants model credentials per
 * agent can attach the right one. Adoption passes none.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisedHandle } from './drivers/session-events.js';

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  const root = `/tmp/nanoclaw-test-gateway-input-${process.pid}`;
  return { ...actual, DATA_DIR: `${root}/data`, GROUPS_DIR: `${root}/groups` };
});
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions: async () => [], prepare, capabilities: () => ({}) };
  return { getSessionDriver: () => driver, isSessionEventsDriver: () => false };
});

import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';
import { type GatewaySessionInput, resetGatewayProvider } from './gateway-providers/index.js';
import type { Session } from './types.js';

const ensure = vi.fn(async (_input: GatewaySessionInput) => ({
  contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
}));

function session(agentProvider: string | null): Session {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: agentProvider,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  };
}

function fakeHandle(): SupervisedHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId: 'sess-1' },
    name: 'nanoclaw-v2-sess-1',
    async start() {},
    async stop() {},
    async status() {
      return { phase: 'running' };
    },
    onTerminal() {},
  } as unknown as SupervisedHandle;
}

beforeEach(async () => {
  ensure.mockClear();
  prepare.mockReset();
  prepare.mockResolvedValue(fakeHandle());
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: [],
    sessions: { ensure },
    approvals: { subscribe: async () => {} },
  });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
});

afterEach(async () => {
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  resetGatewayProvider();
  await closeDb();
  fs.rmSync(`/tmp/nanoclaw-test-gateway-input-${process.pid}`, { recursive: true, force: true });
});

describe('gateway session input on spawn', () => {
  it('names the provider a group with no configured provider runs (claude)', async () => {
    await createSession(session(null));
    expect(await wakeContainer(session(null))).toBe(true);
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'create', provider: 'claude' }),
      expect.anything(),
    );
  });

  it("names the session's pinned provider, resolved as spawn resolves it", async () => {
    await createSession(session('Fixture-Provider'));
    expect(await wakeContainer(session('Fixture-Provider'))).toBe(true);
    expect(ensure.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ disposition: 'create', provider: 'fixture-provider' }),
    );
  });
});
