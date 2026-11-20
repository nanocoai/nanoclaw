/**
 * A start the driver refuses on policy fails the same way on every retry, so
 * it must not read like a transient blip. The live case: a bad mount made the
 * driver deny every start, and the only trace was a once-a-minute warning
 * promising that host-sweep would retry. The warning stays as it is: installed
 * skills anchor on that exact line.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  const root = `/tmp/nanoclaw-test-policy-refusal-${process.pid}`;
  return { ...actual, DATA_DIR: `${root}/data`, GROUPS_DIR: `${root}/groups` };
});
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions: async () => [], prepare, capabilities: () => ({}) };
  return { getSessionDriver: () => driver, isSessionEventsDriver: () => false };
});
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { wakeContainer } from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';
import { asFailureError, deniedByPolicy } from './drivers/types.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import { log } from './log.js';
import type { Session } from './types.js';

function session(): Session {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now,
    created_at: now,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  prepare.mockReset();
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: [],
    sessions: {
      ensure: async () => ({
        contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
      }),
    },
    approvals: { subscribe: async () => {} },
  });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
  await createSession(session());
});

afterEach(async () => {
  resetGatewayProvider();
  await closeDb();
  fs.rmSync(`/tmp/nanoclaw-test-policy-refusal-${process.pid}`, { recursive: true, force: true });
});

const RETRY_WARNING = 'wakeContainer failed — host-sweep will retry';

describe('wakeContainer when the driver refuses the start', () => {
  it('adds an error naming the cause of a policy refusal, after the unchanged retry warning', async () => {
    const detail = 'mount /install/container/agent-runner/src must be classed install-surface, not allowlisted-extra';
    prepare.mockRejectedValue(deniedByPolicy(detail));

    expect(await wakeContainer(session())).toBe(false);

    expect(log.warn).toHaveBeenCalledWith(RETRY_WARNING, expect.objectContaining({ sessionId: 'sess-1' }));
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/refused/i),
      expect.objectContaining({ sessionId: 'sess-1', kind: 'denied-by-policy', detail }),
    );
  });

  it('keeps the retry warning for a failure a retry can clear', async () => {
    const err = asFailureError({ kind: 'runtime-unavailable', retryable: true });
    prepare.mockRejectedValue(err);

    expect(await wakeContainer(session())).toBe(false);

    // Without these, an unrelated failure before the driver was reached would pass too.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(RETRY_WARNING, expect.objectContaining({ sessionId: 'sess-1', err }));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringMatching(/refused/i), expect.anything());
  });
});
