/**
 * Egress lockdown applies to adopted sessions too. A container that was
 * running before lockdown was turned on keeps the network it started with, so
 * adoption must stop it and let the next wake spawn it on the locked network.
 * Drives the real Docker driver and lockdown policy against a scripted CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeCli } from './drivers/fake-cli.js';

const CONTAINER = 'ncl-fixture-sess-1';

const state = vi.hoisted(() => ({
  lockdown: true,
  /** Networks the adopted container is attached to, as `docker inspect` reports them; null fails the read. */
  networks: {} as Record<string, unknown> | null,
  alive: true,
  /** The daemon refuses to stop or remove the container. */
  stopFails: false,
  /** Runs when the adopted container's networks are read (after it is registered). */
  onNetworksRead: undefined as (() => void) | undefined,
  cli: undefined as unknown,
}));

class ScriptedCli extends FakeCli {
  override run(args: string[], opts?: { input?: string }): string {
    super.run(args, opts);
    const joined = args.join(' ');
    if (args[0] === 'ps' && joined.includes('label=nanoclaw-role=agent')) {
      return state.alive ? `${CONTAINER}|running|ag-1|sess-1\n` : '';
    }
    if (args[0] === 'ps' && joined.includes('name=^/')) return state.alive ? CONTAINER : '';
    if (args[0] === 'inspect' && joined.includes('.NetworkSettings.Networks')) {
      state.onNetworksRead?.();
      if (!state.networks) throw new Error('Error response from daemon');
      return JSON.stringify(state.networks);
    }
    if (args[0] === 'inspect') {
      if (!state.alive) throw new Error('No such object');
      return 'running|0';
    }
    if (args[0] === 'stop' || args[0] === 'rm') {
      if (state.stopFails) throw new Error('Error response from daemon');
      state.alive = false;
    }
    return '';
  }
}

vi.mock('./drivers/cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drivers/cli.js')>()),
  realCli: () => state.cli,
}));
// The lockdown module shells docker directly for the network and gateway.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: ((bin: string, args: string[], opts: unknown) =>
      bin === 'docker'
        ? args.includes('{{.Internal}}')
          ? 'true'
          : args.includes('--format')
            ? 'fixture-gateway '
            : ''
        : actual.execFileSync(bin, args, opts as never)) as typeof actual.execFileSync,
  };
});
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  EGRESS_NETWORK: 'fixture-egress',
  get EGRESS_LOCKDOWN() {
    return state.lockdown;
  },
}));

import {
  _resetAdoptionRetryStateForTesting,
  _setFinishFenceScheduleForTesting,
  adoptRunningSessions,
  isContainerRunning,
  killContainer,
  retryPendingAdoptions,
  wakeContainer,
} from './container-runner.js';
import { resetSessionDriver } from './drivers/index.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession, getSession } from './db/index.js';
import { resetGatewayProvider } from './gateway-providers/index.js';

const release = vi.fn(async () => {});

function now(): string {
  return new Date().toISOString();
}

function cli(): ScriptedCli {
  return state.cli as ScriptedCli;
}

function stopCalls(): string[] {
  return cli()
    .joined()
    .filter((call) => call.startsWith('stop '));
}

beforeEach(async () => {
  state.lockdown = true;
  state.networks = {};
  state.alive = true;
  state.stopFails = false;
  state.onNetworksRead = undefined;
  state.cli = new ScriptedCli('docker');
  release.mockClear();
  resetSessionDriver();
  _resetAdoptionRetryStateForTesting();
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: [],
    sessions: {
      ensure: async () => ({
        contribution: {
          networkAccess: {
            endpoint: 'host.docker.internal',
            target: { kind: 'runtime' as const, identity: 'fixture-gateway' },
          },
        },
        release,
      }),
    },
    approvals: { subscribe: async () => {} },
  });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  state.stopFails = false;
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  _setFinishFenceScheduleForTesting();
  resetSessionDriver();
  resetGatewayProvider();
  await closeDb();
});

describe('adopting a running container under egress lockdown', () => {
  it('stops a container that is not on the locked network', async () => {
    state.networks = { bridge: {} };

    const { adopted, stopped } = await adoptRunningSessions();

    expect({ adopted, stopped }).toEqual({ adopted: 0, stopped: 1 });
    expect(isContainerRunning('sess-1')).toBe(false);
    expect(stopCalls()).toContain(`stop -t 1 ${CONTAINER}`);
    expect(state.alive).toBe(false);
    // The ordinary stop path: session marked stopped, gateway lease ended, so
    // the sweep retries any in-flight turn on a fresh, locked-down container.
    expect((await getSession('sess-1'))?.container_status).toBe('stopped');
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'network-policy-changed' });
  });

  it('stops a container on the locked network that is also on another network', async () => {
    state.networks = { 'fixture-egress': {}, bridge: {} };

    const { adopted, stopped } = await adoptRunningSessions();

    expect({ adopted, stopped }).toEqual({ adopted: 0, stopped: 1 });
    expect(stopCalls()).toContain(`stop -t 1 ${CONTAINER}`);
    expect(state.alive).toBe(false);
  });

  it('stops a container whose networks cannot be read', async () => {
    state.networks = null;

    const { adopted, stopped } = await adoptRunningSessions();

    expect({ adopted, stopped }).toEqual({ adopted: 0, stopped: 1 });
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'network-reconcile-failed' });
  });

  it('leaves a container that is only on the locked network running', async () => {
    state.networks = { 'fixture-egress': {} };

    const { adopted, stopped } = await adoptRunningSessions();

    expect({ adopted, stopped }).toEqual({ adopted: 1, stopped: 0 });
    expect(isContainerRunning('sess-1')).toBe(true);
    expect(stopCalls()).toEqual([]);
  });

  it('changes nothing when lockdown is off', async () => {
    state.lockdown = false;
    state.networks = { bridge: {} };

    const { adopted, stopped } = await adoptRunningSessions();

    expect({ adopted, stopped }).toEqual({ adopted: 1, stopped: 0 });
    expect(isContainerRunning('sess-1')).toBe(true);
    expect(stopCalls()).toEqual([]);
    expect(
      cli()
        .joined()
        .some((call) => call.includes('.NetworkSettings.Networks')),
    ).toBe(false);
  });

  it('applies the same check when the wake path retries a deferred adoption', async () => {
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    expect(state.alive).toBe(true);

    // Let the retry run for real, then end the fresh spawn it falls through to
    // before that touches the filesystem.
    const groups = await import('./db/agent-groups.js');
    const getAgentGroup = groups.getAgentGroup;
    const groupLookups = vi
      .spyOn(groups, 'getAgentGroup')
      .mockImplementationOnce(getAgentGroup)
      .mockResolvedValueOnce(undefined);

    await wakeContainer((await getSession('sess-1'))!);

    expect(stopCalls()).toContain(`stop -t 1 ${CONTAINER}`);
    expect(state.alive).toBe(false);
    expect(isContainerRunning('sess-1')).toBe(false);
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'network-policy-changed' });
    expect(groupLookups).toHaveBeenCalledTimes(2);
  });

  it('a wake that arrives during the sweep retry goes on to the spawn path once the retry has stopped the container', async () => {
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    const session = (await getSession('sess-1'))!;
    // The retry's own group read runs for real; the spawn the wake then starts
    // ends at its group read, before it touches the filesystem.
    const groups = await import('./db/agent-groups.js');
    const getAgentGroup = groups.getAgentGroup;
    const groupLookups = vi
      .spyOn(groups, 'getAgentGroup')
      .mockImplementationOnce(getAgentGroup)
      .mockResolvedValueOnce(undefined);

    const sweep = retryPendingAdoptions();
    const woke = wakeContainer(session);
    await sweep;

    expect(await woke).toBe(true);
    expect(state.alive).toBe(false);
    expect(groupLookups).toHaveBeenCalledTimes(2);
  });

  it('a wake that arrives while the sweep retry is stopping the container waits, then goes on to the spawn path', async () => {
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    const session = (await getSession('sess-1'))!;
    const groups = await import('./db/agent-groups.js');
    const getAgentGroup = groups.getAgentGroup;
    const groupLookups = vi
      .spyOn(groups, 'getAgentGroup')
      .mockImplementationOnce(getAgentGroup)
      .mockResolvedValueOnce(undefined);
    // Wake while the retry has the survivor registered and is about to stop it.
    let woke: Promise<boolean> | undefined;
    state.onNetworksRead = () => {
      woke ??= wakeContainer(session);
    };

    await retryPendingAdoptions();

    expect(await woke).toBe(true);
    expect(state.alive).toBe(false);
    expect(groupLookups).toHaveBeenCalledTimes(2);
  });

  it('the sweep retries a deferred adoption for an idle session, without spawning', async () => {
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    const groups = await import('./db/agent-groups.js');
    const groupLookups = vi.spyOn(groups, 'getAgentGroup');

    await retryPendingAdoptions();

    expect(state.alive).toBe(false);
    expect(isContainerRunning('sess-1')).toBe(false);
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'network-policy-changed' });
    // Only the retry's own group read: the sweep never falls through to a spawn.
    expect(groupLookups).toHaveBeenCalledTimes(1);
  });

  it('does not spawn from the wake-path retry while the stop is still being retried', async () => {
    _setFinishFenceScheduleForTesting([], 10);
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    const groups = await import('./db/agent-groups.js');
    const groupLookups = vi.spyOn(groups, 'getAgentGroup');
    state.stopFails = true;

    expect(await wakeContainer((await getSession('sess-1'))!)).toBe(false);

    // Still registered with its teardown pending, no fresh spawn, no new claim.
    expect(isContainerRunning('sess-1')).toBe(true);
    expect(groupLookups).toHaveBeenCalledTimes(1);
    expect((await coordination.getSessionClaim('sess-1'))?.incarnation).toBe(1);
    state.stopFails = false;
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    expect(state.alive).toBe(false);
  });

  it('a wake waiting on the sweep retry reports failure when the retry could not stop the container', async () => {
    _setFinishFenceScheduleForTesting([], 10);
    state.networks = { bridge: {} };
    const coordination = await import('./db/coordination.js');
    vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    await adoptRunningSessions();
    const session = (await getSession('sess-1'))!;
    state.stopFails = true;

    const sweep = retryPendingAdoptions();
    const woke = wakeContainer(session);
    await sweep;

    expect(await woke).toBe(false);
    state.stopFails = false;
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  });
});
