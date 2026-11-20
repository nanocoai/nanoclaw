/**
 * Session-claim writes through the real lifecycle: adoption claims a session
 * (incarnation bump + CAS), finalization releases the claim. (Originally
 * written for the shadow phase; the rows are now the fencing authority and
 * every assertion carried unchanged.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DockerSessionDriver } from './drivers/docker-driver.js';
import { FakeCli } from './drivers/fake-cli.js';
import { type SupervisedHandle, type SupervisedSnapshot, withSessionEvents } from './drivers/session-events.js';
import { FIXTURE_POLICY, fixtureSpec } from './drivers/spec-fixture.js';

const snapshots: SupervisedSnapshot[] = [];
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({
    listSessions: async () => snapshots,
    capabilities: () => ({}),
  }),
  isSessionEventsDriver: () => false,
}));

import {
  abortGatewaySessionObservers,
  adoptRunningSessions,
  _setFinishFenceScheduleForTesting,
  isContainerRunning,
  killContainer,
} from './container-runner.js';
import { type GatewaySessionInput, resetGatewayProvider } from './gateway-providers/index.js';
const release = vi.fn(async () => {});
const ensure = vi.fn(async (_input: GatewaySessionInput) => ({
  contribution: {
    networkAccess: { endpoint: 'http://proxy:8080', target: { kind: 'runtime' as const, identity: 'proxy' } },
  },
  release,
}));
const reapOrphans = vi.fn(async () => {});
import { getSessionClaim } from './db/coordination.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';

function now(): string {
  return new Date().toISOString();
}

function fakeHandle(sessionId: string, name: string, options: { stopFiresTerminal?: boolean } = {}): SupervisedHandle {
  const { stopFiresTerminal = true } = options;
  const terminalCallbacks: Array<(failure?: unknown) => void> = [];
  return {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name,
    async start() {},
    async stop() {
      if (!stopFiresTerminal) return;
      for (const callback of terminalCallbacks) callback(undefined);
    },
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminalCallbacks.push(callback);
    },
  } as unknown as SupervisedHandle;
}

/**
 * Docker right after `docker stop` on a `--rm` container: its own removal is
 * still running, so `rm --force` is refused and probes (`ps` or `inspect`)
 * still see the container for the next `probesWhileRemoving` probes.
 */
class AutoRemovingCli extends FakeCli {
  #removing: string | undefined;
  /** Set once a probe found the container gone, so a stop that just swallowed the error is caught. */
  probedGone = false;

  constructor(private probesWhileRemoving: number) {
    super('docker');
  }

  override run(args: string[], opts?: Parameters<FakeCli['run']>[1]): string {
    const name = this.#removing;
    if (name === undefined || (args.at(-1) !== name && !args.includes(`name=^/${name}$`))) {
      const output = super.run(args, opts);
      if (args[0] === 'stop') this.#removing = args.at(-1);
      return output;
    }
    const scripted = this.responses;
    this.responses = [];
    super.run(args, opts); // record the call only
    this.responses = scripted;
    const present = this.probesWhileRemoving > 0;
    if (args[0] === 'rm') {
      if (present) throw new Error(`Error response from daemon: removal of container ${name} is already in progress`);
      return '';
    }
    if (args[0] !== 'ps' && args[0] !== 'inspect') return '';
    if (present) this.probesWhileRemoving--;
    else this.probedGone = true;
    if (args[0] === 'ps') return present ? `${name}\n` : '';
    if (!present) throw new Error(`Error response from daemon: No such container: ${name}`);
    return 'removing\n';
  }
}

beforeEach(async () => {
  snapshots.length = 0;
  release.mockClear();
  ensure.mockClear();
  reapOrphans.mockClear();
  resetGatewayProvider({
    kind: 'test-lifecycle',
    agentSkills: [],
    sessions: { ensure, reapOrphans },
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
  // Drain any runtime left registered so cross-test state cannot leak.
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  resetGatewayProvider();
  await closeDb();
});

describe('session claim lifecycle', () => {
  it('adoption shadow-claims the session and finalization releases it', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    const { adopted } = await adoptRunningSessions();
    expect(adopted).toBe(1);
    expect(ensure.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ disposition: 'adopt' }));
    expect(reapOrphans).toHaveBeenCalledOnce();

    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(1);
    expect(claim?.claimed_by).toMatch(/:\d+$/);
    expect(claim?.container_ref).toBe('container-a');

    killContainer('sess-1', 'test-stop');
    await vi.waitFor(async () => {
      const released = await getSessionClaim('sess-1');
      expect(released?.claimed_by).toBeNull();
      expect(released?.incarnation).toBe(1);
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'test-stop' }));
  });

  it('a re-adopted session bumps the incarnation via CAS', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    killContainer('sess-1', 'test-stop');
    await vi.waitFor(async () => expect((await getSessionClaim('sess-1'))?.claimed_by).toBeNull());

    snapshots.length = 0;
    snapshots.push({ handle: fakeHandle('sess-1', 'container-b'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(2);
    expect(claim?.container_ref).toBe('container-b');
  });
  it('retains the claim and lease until a failed runtime stop can be retried', async () => {
    _setFinishFenceScheduleForTesting([], 10);
    const handle = fakeHandle('sess-1', 'container-a');
    const stop = handle.stop.bind(handle);
    const failedStop = vi.fn(async () => {
      throw new Error('runtime unavailable');
    });
    handle.stop = failedStop;
    snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    killContainer('sess-1', 'test-stop');
    await vi.waitFor(() => expect(failedStop).toHaveBeenCalled());
    expect(release).not.toHaveBeenCalled();
    expect((await getSessionClaim('sess-1'))?.claimed_by).not.toBeNull();
    handle.stop = stop;
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'test-stop' }));
    _setFinishFenceScheduleForTesting();
  });

  it('killContainer stops the handle twice: once directly and once from finish', async () => {
    // Supervision is gone: stop() resolves without firing terminal callbacks,
    // so only killContainer's post-stop fallback can reach finish().
    const handle = fakeHandle('sess-1', 'container-a', { stopFiresTerminal: false });
    const stop = vi.spyOn(handle, 'stop');
    snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    killContainer('sess-1', 'test-stop');
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'test-stop' }));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls.map(([reason]) => reason)).toEqual(['test-stop', 'test-stop']);
  });

  it('releases the claim at once when a kill races Docker’s --rm auto-removal', async () => {
    // A live install: the kill's stop and finish()'s stop both still saw the
    // container, so the claim and lease waited out the 60s deferred finish.
    const cli = new AutoRemovingCli(2);
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    const agent = { ...fixtureSpec().containers[0]!, mounts: [] };
    const spec = fixtureSpec({
      key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId: 'sess-1' },
      containers: [agent],
    });
    const handle = await withSessionEvents(new DockerSessionDriver({ ...FIXTURE_POLICY, cli })).prepare(spec);
    await handle.start();
    snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();

    let goneAtRelease: boolean | undefined;
    release.mockImplementationOnce(async () => {
      goneAtRelease = cli.probedGone;
    });
    killContainer('sess-1', 'absolute-ceiling');
    await vi.waitFor(
      () => expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'absolute-ceiling' }),
      { timeout: 3_000 },
    );
    // The lease is held until the driver has seen the container gone.
    expect(goneAtRelease).toBe(true);
    expect((await getSessionClaim('sess-1'))?.claimed_by).toBeNull();
  });

  it('awaits detachment on host replacement while leaving the session running', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    await abortGatewaySessionObservers();
    expect(release).toHaveBeenCalledWith({ kind: 'host-detached', reason: 'host-shutdown' });
    expect(isContainerRunning('sess-1')).toBe(true);
  });
});
