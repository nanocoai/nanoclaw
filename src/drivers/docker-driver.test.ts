/**
 * Docker driver — behavioral tests.
 *
 * These replace the source-text assertions that used to live in
 * `container-runner.test.ts` and `container-runtime.test.ts`. Those read the
 * module as a string and regexed it, so a byte-identical move broke them while
 * a behavior change could slip past. Everything here drives a real spec through
 * the real realization path against an injected fake CLI and asserts on the
 * commands the driver actually issued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerSessionDriver, dockerEventToSessionEvent, ensureDockerRunning } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { withSessionEvents } from './session-events.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import { LABELS, type SessionEvent } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The driver re-checks mount sources exist; fixture paths are not real files
// on the test host. A vi.fn so single tests can flip it to "missing".
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

import fs from 'fs';

import { log } from '../log.js';

let cli: FakeCli;

function driver(): DockerSessionDriver {
  return new DockerSessionDriver({ ...FIXTURE_POLICY, cli });
}

/** `inspect` is how the driver asks "does this exist?" — default to "no". */
function createArgs(): string[] {
  const call = cli.callMatching(/^create /);
  expect(call, 'expected a `docker create` call').toBeDefined();
  return call!.args;
}

beforeEach(() => {
  vi.clearAllMocks();
  cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
});

describe('spec realization', () => {
  it('emits the agent container with its image, entrypoint split and canonical labels', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();

    expect(args.slice(0, 4)).toEqual(['create', '--rm', '--name', 'ncl-spike-s1']);
    // Derived from the key, not from the timestamped lineage label — `prepare`
    // cannot be idempotent on key if the name it allocates keeps changing.
    // The four canonical labels are the adoption contract: a handle must be
    // rebuildable from these alone.
    expect(args).toContain(`${LABELS.install}=spike`);
    expect(args).toContain(`${LABELS.group}=g1`);
    expect(args).toContain(`${LABELS.session}=s1`);
    expect(args).toContain(`${LABELS.role}=agent`);
    // Lineage labels from the spec and from the egress contribution both land.
    expect(args).toContain('nanoclaw-container-name=nanoclaw-v2-agent-one-1700000000000');
    expect(args).toContain('session-channel=channel-abc');
    // PID 1 is split across --entrypoint and the post-image argv.
    expect(args).toContain('--entrypoint');
    expect(args.slice(args.indexOf('nanoclaw-agent:spike-p0'))).toEqual([
      'nanoclaw-agent:spike-p0',
      '-c',
      'exec bun run /app/src/index.ts',
    ]);
  });

  it('applies the standard hardening posture, including --init', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();

    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    // Not optional: overriding the entrypoint defeats the image's tini, and
    // without docker-init SIGTERM to PID 1 is discarded and every stop ends in
    // SIGKILL after the full grace period.
    expect(args).toContain('--init');
    expect(args.join(' ')).toContain('--pids-limit 2048');
  });

  it('omits the pids limit for 0, negatives and absent values', async () => {
    for (const pidsLimit of [0, -1, undefined]) {
      cli = new FakeCli('docker');
      cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
      await driver().prepare(fixtureSpec({ resources: { pidsLimit, shmSizeMb: 1024 } }));
      // cgroups v2 rejects `--pids-limit 0` with EINVAL and fails the spawn.
      expect(createArgs().join(' ')).not.toContain('--pids-limit');
    }
  });

  it('leaves cpu and memory unbounded unless the operator opted in', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs().join(' ');

    // Empty knobs emit no flag — today's behavior, and not something to change
    // silently while porting.
    expect(args).not.toContain('--cpus');
    expect(args).not.toContain('--memory');
    expect(args).not.toContain('--memory-swap');
  });

  it('emits cpu, memory and shm flags when the spec sets them', async () => {
    await driver().prepare(fixtureSpec({ resources: { cpus: '2', memoryMb: 8192, shmSizeMb: 1024 } }));
    const args = createArgs().join(' ');

    expect(args).toContain('--cpus 2');
    expect(args).toContain('--memory 8192m');
    expect(args).toContain('--shm-size=1024m');
    expect(args).not.toContain('--memory-swap');
  });

  it('maps the spec identity onto --user rather than trusting the image', async () => {
    await driver().prepare(fixtureSpec());
    expect(createArgs().join(' ')).toContain('--user 501:1000');
  });

  it('mounts read-only where the spec says ro, and read-write otherwise', async () => {
    await driver().prepare(fixtureSpec());
    const args = createArgs();

    expect(args).toContain('/install/data/v2-sessions/g1/s1:/workspace');
    expect(args).toContain('/install/container/agent-runner/src:/app/src:ro');
  });

  it('applies egress-contributed mounts after ordinary mounts and before the image', async () => {
    // The invariant the old positional test guarded: a nested read-only public
    // CA must not be shadowed by its writable parent.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/pki/proxy-ca.pem',
      containerPath: '/run/session/proxy-ca.pem',
      mode: 'ro',
      groupScope: 'g1',
    });
    await driver().prepare(spec);
    const args = createArgs();

    const workspace = args.indexOf('/install/data/v2-sessions/g1/s1:/workspace');
    const proxyCa = args.indexOf('/pki/proxy-ca.pem:/run/session/proxy-ca.pem:ro');
    const image = args.indexOf('nanoclaw-agent:spike-p0');
    expect(workspace).toBeGreaterThan(-1);
    expect(proxyCa).toBeGreaterThan(workspace);
    expect(image).toBeGreaterThan(proxyCa);
  });

  it('carries exactly one value per env key, and never a credential', async () => {
    const spec = fixtureSpec();
    spec.containers[0].env = { TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' };
    await driver().prepare(spec);
    const args = createArgs();

    const proxies = args.filter((a) => a.startsWith('HTTPS_PROXY='));
    expect(proxies).toEqual(['HTTPS_PROXY=http://127.0.0.1:15001']);
    expect(args.join(' ')).not.toContain('Proxy-Authorization');
  });

  it('realizes the injected network topology after the spec env and mounts', async () => {
    // Topology is driver-private: injected at registration (`drivers/index.ts`),
    // never carried on the spec. Argv-shaped input has no channel through
    // composition anymore.
    const d = new DockerSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      networkArgsFor: () => ['--network', 'nc-spike-abcd-session'],
    });
    await d.prepare(fixtureSpec());
    const args = createArgs();

    const network = args.indexOf('nc-spike-abcd-session');
    const lastMount = args.indexOf('/install/container/CLAUDE.md:/app/CLAUDE.md:ro');
    const image = args.indexOf('nanoclaw-agent:spike-p0');
    expect(network).toBeGreaterThan(lastMount);
    expect(image).toBeGreaterThan(network);
  });

  it('emits contributed env after composed env, so the contributed value wins last-wins', async () => {
    // The contract's override rule (ContainerSpec.contributedEnv), realized in
    // Docker vocabulary: the later `-e` wins.
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { HTTPS_PROXY: 'http://gateway-must-win:15001' };
    await driver().prepare(spec);
    const args = createArgs();

    const proxies = args.filter((a) => a.startsWith('HTTPS_PROXY='));
    expect(proxies).toHaveLength(2);
    expect(proxies.at(-1)).toBe('HTTPS_PROXY=http://gateway-must-win:15001');
  });

  it('refuses to invent a missing mount source — Docker would mount a fresh empty directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });
});

describe('spec validation', () => {
  it('rejects identity material on the agent container', async () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'identity-material',
      hostPath: '/install/data/session-materials/channel-abc-XXXX/session-key.pem',
      containerPath: '/run/session/session-key.pem',
      mode: 'ro',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('rejects a group-state mount that escapes the group subtree', async () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'group-state',
      hostPath: '/install/data/v2-sessions/g2/s9',
      containerPath: '/workspace/other',
      mode: 'rw',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  it('rejects an install-surface mount outside the enumerated surface roots', async () => {
    // The state roots nest inside the project root, so a bare prefix check would
    // admit the central DB as a mountable "surface".
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: '/install/data/v2.db',
      containerPath: '/app/v2.db',
      mode: 'ro',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  it('rejects a secret-shaped env key', async () => {
    const spec = fixtureSpec();
    spec.containers[0].env.ANTHROPIC_API_KEY = 'sk-live';

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  it('rejects a spec with no agent container', async () => {
    const spec = fixtureSpec();
    spec.containers = spec.containers.filter((c) => c.role !== 'agent');

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'spec-invalid' });
  });
});

describe('failure normalization', () => {
  const cases: Array<[string, string]> = [
    ['manifest unknown', 'image-unavailable'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 'runtime-unavailable'],
    ['no space left on device', 'resources-exhausted'],
    ['something nobody predicted', 'unknown'],
  ];

  for (const [message, kind] of cases) {
    it(`maps "${message}" to ${kind}`, async () => {
      cli.responses = [
        { match: /^inspect /, throws: new Error('No such object') },
        { match: /^create /, throws: new Error(message) },
      ];
      await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind });
    });
  }

  it('never lets the raw runtime error cross the seam', async () => {
    cli.responses = [
      { match: /^inspect /, throws: new Error('No such object') },
      { match: /^create /, throws: new Error('/secrets/session-key.pem: permission denied') },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toThrow(/^session realization failed: unknown$/);
  });

  it('leaves nothing allocated when create fails', async () => {
    cli.responses = [
      { match: /^inspect /, throws: new Error('No such object') },
      { match: /^create /, throws: new Error('boom') },
    ];
    await expect(driver().prepare(fixtureSpec())).rejects.toThrow();
    expect(cli.joined().some((c) => c.startsWith('rm --force ncl-spike-s1'))).toBe(true);
  });
});

describe('lifecycle', () => {
  /** The hub delivers a tick after the runtime's event: it re-reads truth first. */
  async function settled(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('supervises via start --attach and the hub reports the exit code once', async () => {
    // onTerminal is hub sugar over the driver-level stream (r2): the attach
    // exit rides watchSessions, and the wrapper — not this driver — owns
    // at-most-once delivery.
    const handle = await withSessionEvents(driver()).prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();

    const started = cli.started.at(-1)!;
    expect(started.args).toEqual(['start', '--attach', 'ncl-spike-s1']);

    started.proc.emitExit(3);
    started.proc.emitExit(3);
    await settled();

    expect(terminal).toHaveBeenCalledExactlyOnceWith({ kind: 'started-then-died', retryable: false, exitCode: 3 });
  });

  it('surfaces the stderr tail at warn when the container exits non-zero', async () => {
    // A container that dies at boot (unknown provider, missing binary, bad
    // config) explains itself only on stderr, which logs at debug.
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();

    const proc = cli.started.at(-1)!.proc;
    proc.emitStderr('Unknown provider: mock. Registered: claude');
    proc.emitExit(1);

    expect(log.warn).toHaveBeenCalledWith(
      'Container exited non-zero',
      expect.objectContaining({ stderrTail: ['Unknown provider: mock. Registered: claude'] }),
    );
  });

  it('does not report a terminal event for a stop the host asked for', async () => {
    // The driver emits the end it observed (no intent filtering, r3); the
    // hub saw stop() through the wrapped handle and suppresses delivery.
    const handle = await withSessionEvents(driver()).prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();

    await handle.stop('host-shutdown');
    cli.started.at(-1)!.proc.emitExit(137);
    await settled();

    expect(terminal).not.toHaveBeenCalled();
  });

  it('stops with the spec grace and then force-removes', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    await handle.stop('sweep-kill');

    expect(cli.joined()).toContain('stop -t 1 ncl-spike-s1');
    expect(cli.joined()).toContain('rm --force ncl-spike-s1');
  });

  it('kills the attach process when docker stop fails, so supervision cannot hang', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    cli.responses = [{ match: /^stop /, throws: new Error('daemon gone') }];

    await handle.stop('sweep-kill');

    expect(cli.started.at(-1)!.proc.killed).toBe(true);
  });

  it('start is idempotent', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    await handle.start();
    expect(cli.started).toHaveLength(1);
  });

  it('does not conclude status while the attach channel is alive and unresolved', async () => {
    // The events stream can outrun the attach exit: 'die' lands, the hub
    // truth-reads, and the `--rm` container is already gone — but the attach
    // process holds the only record of HOW it ended. A 'stopped' here would
    // spend the hub's at-most-once terminal delivery without the exit code.
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();

    expect((await handle.status()).phase).toBe('running');

    cli.started.at(-1)!.proc.emitExit(137);
    expect(await handle.status()).toEqual({
      phase: 'failed',
      failure: { kind: 'started-then-died', retryable: false, exitCode: 137 },
    });
  });
});

describe('idempotency and adoption', () => {
  it('returns the existing session rather than creating a second one', async () => {
    cli.responses = [{ match: /^inspect /, output: 'spike|g1|s1\n' }];

    const handle = await driver().prepare(fixtureSpec());

    expect(handle.name).toBe('ncl-spike-s1');
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('refuses a name collision with a container that is not this session', async () => {
    // The name is key-derived, but a foreign container can wear it — another
    // install whose truncated identity collides, or an operator's hand-made
    // container. Adopting by name would attach the session to a runtime it
    // does not own.
    cli.responses = [{ match: /^inspect /, output: 'other-install|g9|s1\n' }];

    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'unknown', retryable: false });
    expect(cli.callMatching(/^create /)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Container name collision: existing container is not this session',
      expect.objectContaining({ containerName: 'ncl-spike-s1' }),
    );
  });

  it('scopes the container name by install, truncating-then-hashing over-length identities', async () => {
    // Two peer installs holding the same session id must never alias one
    // runtime object; distinct keys sharing a truncated prefix must not either.
    const longA = fixtureSpec({ key: { installSlug: 'x'.repeat(60), agentGroupId: 'g1', sessionId: 'same' } });
    const longB = fixtureSpec({ key: { installSlug: 'x'.repeat(61), agentGroupId: 'g1', sessionId: 'same' } });
    await driver().prepare(longA);
    const first = createArgs()[3];
    cli = new FakeCli('docker');
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    await driver().prepare(longB);
    const second = createArgs()[3];

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(52); // 'ncl-' + 48
    expect(second.length).toBeLessThanOrEqual(52);
  });

  it('rebuilds handles from labels alone, filtered to this install and the agent role', async () => {
    cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\nncl-spike-s2|running|g2|s2\n' }];

    const snapshots = await driver().listSessions('spike');

    const psArgs = cli.callMatching(/^ps -a/)!.args.join(' ');
    // Scoped by install label so a crash-looping peer install cannot reap our
    // containers, and we cannot reap theirs.
    expect(psArgs).toContain(`label=${LABELS.install}=spike`);
    expect(psArgs).toContain(`label=${LABELS.role}=agent`);
    expect(snapshots.map((s) => s.handle.key)).toEqual([
      { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
      { installSlug: 'spike', agentGroupId: 'g2', sessionId: 's2' },
    ]);
  });

  it('phases the listing itself: exited is a corpse, created is not', async () => {
    // `ps -a` sees exited and created containers; the `{{.State}}` column is
    // what lets adoption tell them apart without a status() per handle. A
    // 'created' container is a prepared-not-started incarnation — calling it
    // terminal would have adoption tear down freshly-prepared sessions.
    cli.responses = [
      {
        match: /^ps -a/,
        output: 'ncl-spike-s1|exited|g1|s1\nncl-spike-s2|created|g2|s2\nncl-spike-s3|running|g3|s3\n',
      },
    ];

    const snapshots = await driver().listSessions('spike');

    expect(snapshots.map((s) => [s.handle.key.sessionId, s.phase])).toEqual([
      ['s1', 'terminal'],
      ['s2', 'starting'],
      ['s3', 'running'],
    ]);
  });

  it('stops pre-seam containers, which carry the install label but no session label', async () => {
    // Containers spawned before the seam cannot be adopted (no session label to
    // rebuild a handle from) and cannot be matched to a session — left running
    // they would race a freshly-named replacement for the same session
    // directory. The old cleanupOrphans() stopped them on every start; this is
    // that behavior, scoped to exactly the containers adoption cannot claim.
    cli.responses = [{ match: /^ps --filter/, output: 'nanoclaw-v2-agent-one-1700000000000|\nncl-spike-s1|s1\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined()).toContain('rm --force nanoclaw-v2-agent-one-1700000000000');
    expect(cli.joined().some((c) => c === 'rm --force ncl-spike-s1')).toBe(false);
  });

  it('reaps install-owned networks whose containers are gone', async () => {
    cli.responses = [{ match: /^network ls/, output: 'nc-spike-a-session\nnc-spike-a-uplink\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined()).toContain('network rm nc-spike-a-session');
    expect(cli.joined()).toContain('network rm nc-spike-a-uplink');
    expect(log.info).toHaveBeenCalledWith('Removed orphaned networks', expect.objectContaining({ count: 2 }));
  });

  it('refuses a network name it did not shape', async () => {
    cli.responses = [{ match: /^network ls/, output: 'network$(id)\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined().some((c) => c.startsWith('network rm'))).toBe(false);
  });
});

describe('watchSessions', () => {
  function dieEvent(sessionId: string, action = 'die'): string {
    return JSON.stringify({
      status: action,
      Type: 'container',
      Action: action,
      Actor: {
        ID: 'abc123',
        Attributes: {
          name: `ncl-${sessionId}`,
          [LABELS.install]: 'spike',
          [LABELS.group]: 'g1',
          [LABELS.session]: sessionId,
          [LABELS.role]: 'agent',
        },
      },
    });
  }

  it('is ONE lazy driver-level `docker events` subscription per install, shared by every subscriber', async () => {
    const d = driver();
    expect(cli.started.filter((s) => s.args[0] === 'events')).toHaveLength(0); // lazy

    const seen: SessionEvent[] = [];
    d.watchSessions('spike', (e) => seen.push(e));
    d.watchSessions('spike', () => {});

    // One subscription for the whole install — never a per-session process.
    const events = cli.started.filter((s) => s.args[0] === 'events');
    expect(events).toHaveLength(1);
    const argv = events[0].args.join(' ');
    expect(argv).toContain(`label=${LABELS.install}=spike`);
    expect(argv).toContain(`label=${LABELS.role}=agent`);
  });

  it('emits terminal hints keyed from the labels the event carries', async () => {
    const d = driver();
    const seen: SessionEvent[] = [];
    d.watchSessions('spike', (e) => seen.push(e));

    const proc = cli.started.find((s) => s.args[0] === 'events')!.proc;
    proc.emitStdout(`${dieEvent('s1')}\n${dieEvent('s2', 'start')}\n`);

    expect(seen).toEqual([
      { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' },
      { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's2' }, kind: 'phase' },
    ]);
  });

  it('stop() unsubscribes one listener without tearing down the shared stream', async () => {
    const d = driver();
    const seen: SessionEvent[] = [];
    const kept: SessionEvent[] = [];
    const watch = d.watchSessions('spike', (e) => seen.push(e));
    d.watchSessions('spike', (e) => kept.push(e));

    watch.stop();
    cli.started.find((s) => s.args[0] === 'events')!.proc.emitStdout(`${dieEvent('s1')}\n`);

    expect(seen).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it('reconnects with bounded backoff when the subscription process dies', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));

      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      const procs = cli.started.filter((s) => s.args[0] === 'events');
      expect(procs).toHaveLength(2);
      // The reconnected stream serves the same subscribers: supervision has no gap.
      procs.at(-1)!.proc.emitStdout(`${dieEvent('s1')}\n`);
      expect(seen).toEqual([{ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the gap on reconnect: corpses and vanished known keys get synthetic terminal hints', async () => {
    // A terminal that happens while the subscription is down was never emitted,
    // and the fresh `docker events` stream starts from now. For an adopted
    // session the stream is the ONLY terminal source (no attach backstop), so
    // an unreconciled gap would leave it 'active' forever.
    vi.useFakeTimers();
    try {
      const d = driver();
      // Two keys the driver knows: during the gap s1 dies and `--rm` removes
      // it (absent from the re-list); s2 dies and sits exited (a corpse).
      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\nncl-spike-s2|running|g1|s2\n' }];
      await d.listSessions('spike');

      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));
      expect(seen).toEqual([]); // the first connect is not a gap — nothing to replay

      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s2|exited|g1|s2\n' }];
      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      // Hints, not transitions: the hub still truth-reads each one.
      expect(seen).toEqual([
        { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's2' }, kind: 'terminal' },
        { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hints nothing when the daemon is still down at reconnect — no false terminals', async () => {
    // With the daemon down, inspect cannot tell removed from unreachable, so a
    // synthetic hint could fire a terminal for a live-restored container. The
    // gate is the re-list: if `ps -a` fails, skip — that same dead daemon
    // exits the events process too, and the next reconnect retries.
    vi.useFakeTimers();
    try {
      const d = driver();
      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\n' }];
      await d.listSessions('spike');
      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));

      cli.responses = [{ match: /^ps -a/, throws: new Error('Cannot connect to the Docker daemon') }];
      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dockerEventToSessionEvent', () => {
  it('drops label-less documents and unknown actions — hints may drop', () => {
    expect(dockerEventToSessionEvent({ Action: 'die', Actor: { Attributes: { name: 'x' } } }, 'spike')).toBeNull();
    expect(
      dockerEventToSessionEvent(
        { Action: 'exec_create: bash', Actor: { Attributes: { [LABELS.group]: 'g1', [LABELS.session]: 's1' } } },
        'spike',
      ),
    ).toBeNull();
    expect(dockerEventToSessionEvent('not an object', 'spike')).toBeNull();
  });
});

describe('ensureDockerRunning', () => {
  it('passes when the daemon answers', () => {
    expect(() => ensureDockerRunning(cli)).not.toThrow();
    expect(cli.joined()).toContain('info');
  });

  it('throws a fatal startup error when it does not', () => {
    cli.responses = [{ match: /^info$/, throws: new Error('Cannot connect to the Docker daemon') }];
    expect(() => ensureDockerRunning(cli)).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});
