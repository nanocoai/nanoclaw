import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adoptUserRuntimeDir,
  CUTOVER_LIST_CLI_TIMEOUT_MS,
  CUTOVER_STOP_CLI_TIMEOUT_MS,
  CONTROLLER_GATEWAY_ROLE,
  CUTOVER_STOP_GRACE_SECONDS,
  DRAIN_LIST_FORMAT,
  createCommandRunner,
  detectService,
  drainContainers,
  gatewayRestartCommand,
  probe,
  restartGatewayContainers,
  shellQuote,
  startCommand,
  startService,
  stopService,
  verifyServiceHealth,
  withRecordedNohupHost,
  type CommandRunner,
  type ServiceEnvironment,
  type ServiceHandle,
} from './service.js';
import { GATEWAY_ROLE, LABELS } from '../../src/drivers/types.js';

const roots: string[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-service-'));
  roots.push(root);
  return root;
}

type FakeResponse = { ok: boolean; stdout?: string; status?: number | null; stderr?: string };

function makeEnv(platform: NodeJS.Platform, responses: Record<string, FakeResponse> = {}) {
  const home = temp();
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key];
      if (response && !response.ok) {
        // Same shape as execFileSync's error: exit status (null when unspawnable) + stderr.
        throw Object.assign(new Error(`Command failed: ${key}\n${response.stderr ?? ''}`), {
          status: response.status === undefined ? 1 : response.status,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
        });
      }
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key] ?? { ok: true, stdout: '' };
      return { ok: response.ok, stdout: response.stdout ?? '' };
    },
  };
  const env: ServiceEnvironment = {
    platform,
    home,
    uid: 1000,
    runner,
    sleep: async () => {},
  };
  return { env, calls, home };
}

function slug(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 8);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('service-mode detection and control', () => {
  it('detects and controls a user systemd unit', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('linux', {
      [`systemctl --user is-active ${name}`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'systemd-user', active: true, name });
    await stopService(handle, env);
    startService(handle, root, env);

    expect(calls).toContain(`systemctl --user stop ${name}`);
    expect(calls).toContain(`systemctl --user start ${name}`);
  });

  it('uses system-level systemctl without --user for root-installed units', async () => {
    const { env, calls } = makeEnv('linux');
    const handle = { mode: 'systemd-system' as const, active: true, name: 'nanoclaw-v2-root' };

    await stopService(handle, env);
    startService(handle, '/srv/nanoclaw', env);

    expect(calls).toEqual(['systemctl stop nanoclaw-v2-root', 'systemctl start nanoclaw-v2-root']);
  });

  it('bootstraps an unloaded launchd plist instead of relying on kickstart alone', () => {
    const root = temp();
    const name = `com.nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('darwin', {
      [`launchctl print gui/1000/${name}`]: { ok: false, status: 113, stderr: 'Could not find service' },
    });
    const plist = path.join(home, 'Library', 'LaunchAgents', `${name}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>\n');
    const detected = detectService(root, env);
    expect(detected).toMatchObject({ mode: 'launchd', active: false });

    startService({ ...detected, active: true }, root, env);
    expect(calls).toContain(`launchctl bootstrap gui/1000 ${plist}`);
    expect(calls).toContain(`launchctl kickstart gui/1000/${name}`);
  });

  it('restarts a WSL/nohup install through its recorded start script', () => {
    const root = temp();
    const definition = path.join(root, 'start-nanoclaw.sh');
    const { env, calls } = makeEnv('linux');

    startService({ mode: 'nohup', active: true, definition, pid: 4242 }, root, env);

    expect(calls).toEqual([`bash ${definition}`]);
  });

  it('prints the start command startService runs, for a rollback finished by hand', () => {
    const { env, calls } = makeEnv('linux');
    const cases: [ServiceHandle, string][] = [
      [
        { mode: 'launchd', active: true, name: 'com.nanoclaw-v2-x', definition: '/Users/me/x.plist' },
        'launchctl bootstrap gui/1000 /Users/me/x.plist; launchctl kickstart gui/1000/com.nanoclaw-v2-x',
      ],
      [
        { mode: 'systemd-user', active: true, name: 'nanoclaw-v2-x' },
        'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}" systemctl --user start nanoclaw-v2-x',
      ],
      [{ mode: 'systemd-system', active: true, name: 'nanoclaw-v2-x' }, 'systemctl start nanoclaw-v2-x'],
      [{ mode: 'nohup', active: true, definition: '/srv/nano/start-nanoclaw.sh' }, 'bash /srv/nano/start-nanoclaw.sh'],
    ];
    for (const [handle, printed] of cases) {
      calls.length = 0;
      startService(handle, '/srv', env);
      expect(startCommand(handle, env.uid)).toBe(printed);
      // Every call startService made appears in the printed command, in order.
      let at = 0;
      for (const call of calls) {
        at = printed.indexOf(call, at);
        expect(at).toBeGreaterThanOrEqual(0);
      }
    }
    expect(startCommand({ mode: 'none', active: false }, env.uid)).toBeUndefined();
    const awkward = "/srv/it's $HOME `nano`";
    expect(spawnSync('sh', ['-c', `printf %s ${shellQuote(awkward)}`], { encoding: 'utf8' }).stdout).toBe(awkward);
  });

  it('prints a gateway restart that restarts the listed containers, and is a no-op when there are none', () => {
    const root = temp();
    const bin = temp();
    const log = path.join(bin, 'calls.log');
    const docker = (listed: string) =>
      fs.writeFileSync(
        path.join(bin, 'docker'),
        `#!/bin/sh\necho "docker $*" >> ${JSON.stringify(log)}\n[ "$1" = ps ] && printf '${listed}'\nexit 0\n`,
        { mode: 0o755 },
      );
    const run = () =>
      spawnSync('sh', ['-c', gatewayRestartCommand(root)], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      }).status;
    const ps = `docker ps -aq --filter label=nanoclaw-install=${slug(root)} --filter label=nanoclaw-role=gateway`;

    docker('gw1\\ngw2\\n');
    expect(run()).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([ps, 'docker restart -t 10 gw1 gw2']);

    fs.rmSync(log);
    docker('');
    expect(run()).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([ps]);
  });

  it('refuses to mutate under an unmanaged pnpm-dev process', async () => {
    const root = temp();
    const pattern = `${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(dist/index\\.js|src/index\\.ts)`;
    const { env } = makeEnv('linux', {
      [`pgrep -f ${pattern}`]: { ok: true, stdout: '1234' },
    });

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'unmanaged', active: true, name: '1234' });
    await expect(stopService(handle, env)).rejects.toThrow('outside a supported service wrapper');
  });
});

describe('liveness probes: running / stopped / probe failed', () => {
  // The bug: `.ok` read every non-zero exit as "stopped". With no user bus
  // (`su -`, cron, non-interactive SSH) systemctl fails before it can look,
  // and cutover then skipped the stop, finish the restart, and the update
  // reported complete against the stale host. Exit 3 is the only "stopped".
  function userUnit(): { root: string; name: string; probeKey: string } {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    return { root, name, probeKey: `systemctl --user is-active ${name}` };
  }
  function writeUserUnit(home: string, name: string): void {
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');
  }
  const busError = 'Failed to connect to bus: No medium found';

  it('systemd --user: exit 3 is stopped, a bus error is a refusal that names the fix', () => {
    const stopped = userUnit();
    const env1 = makeEnv('linux', { [stopped.probeKey]: { ok: false, status: 3 } });
    writeUserUnit(env1.home, stopped.name);
    expect(detectService(stopped.root, env1.env)).toMatchObject({ mode: 'systemd-user', active: false });

    const failed = userUnit();
    const env2 = makeEnv('linux', { [failed.probeKey]: { ok: false, status: 1, stderr: busError } });
    writeUserUnit(env2.home, failed.name);
    expect(() => detectService(failed.root, env2.env)).toThrow(/Cannot tell whether NanoClaw is running/);
    expect(() => detectService(failed.root, env2.env)).toThrow(/No medium found/);
    expect(() => detectService(failed.root, env2.env)).toThrow(/XDG_RUNTIME_DIR=\/run\/user\/1000/);
    // Nothing else ran: the refusal is the whole outcome.
    expect(env2.calls).toEqual([failed.probeKey, failed.probeKey, failed.probeKey]);
  });

  it('a unit mid restart is stopped by cutover but never passes health', async () => {
    const restarting = userUnit();
    const { env, home, calls } = makeEnv('linux', {
      [restarting.probeKey]: { ok: false, status: 3, stdout: 'deactivating' },
      [`${path.join(restarting.root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    writeUserUnit(home, restarting.name);
    const handle = detectService(restarting.root, env);
    expect(handle).toMatchObject({ mode: 'systemd-user', active: true, transitional: true });
    await stopService(handle, env);
    expect(calls).toContain(`systemctl --user stop ${restarting.name}`);

    fs.mkdirSync(path.join(restarting.root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(restarting.root, 'data', 'ncl.sock'), 'test socket stand-in');
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      env.sleep = async () => {
        clock += 500;
      };
      await expect(
        verifyServiceHealth({ ...handle, transitional: undefined }, restarting.root, env, 1_000),
      ).resolves.toBe(false);
    } finally {
      now.mockRestore();
    }
    expect(calls).not.toContain(`${path.join(restarting.root, 'bin', 'ncl')} groups list`);
  });

  it('systemd (system unit): exit 3 is stopped, anything else refuses', () => {
    // /etc/systemd/system is not writable from a test, so the system-unit
    // branch is exercised through the shared helper with its exact arguments.
    const args = ['is-active', 'nanoclaw-v2-x'];
    const key = `systemctl ${args.join(' ')}`;
    const stopped = makeEnv('linux', { [key]: { ok: false, status: 3, stdout: 'inactive' } });
    expect(probe(stopped.env, 'systemctl', args, [3], 'hint')).toBeUndefined();
    const running = makeEnv('linux', { [key]: { ok: true, stdout: 'active' } });
    expect(probe(running.env, 'systemctl', args, [3], 'hint')).toEqual({ stdout: 'active', transitional: false });
    const broken = makeEnv('linux', { [key]: { ok: false, status: 1, stderr: busError } });
    expect(() => probe(broken.env, 'systemctl', args, [3], 'hint')).toThrow(/No medium found.*hint/s);
    // Restart=always: a unit mid auto-restart also exits 3 but still holds the
    // service, so it counts as running and gets stopped; `failed` is stopped.
    const restarting = makeEnv('linux', { [key]: { ok: false, status: 3, stdout: 'activating' } });
    expect(probe(restarting.env, 'systemctl', args, [3], 'hint')).toEqual({ stdout: 'activating', transitional: true });
    const crashed = makeEnv('linux', { [key]: { ok: false, status: 3, stdout: 'failed' } });
    expect(probe(crashed.env, 'systemctl', args, [3], 'hint')).toBeUndefined();
  });

  it('launchd: 113 (not loaded) is stopped, 112 (no domain, e.g. SSH without a GUI session) refuses', () => {
    const root = temp();
    const name = `com.nanoclaw-v2-${slug(root)}`;
    const key = `launchctl print gui/1000/${name}`;
    const notLoaded = makeEnv('darwin', { [key]: { ok: false, status: 113, stderr: 'Could not find service' } });
    fs.mkdirSync(path.join(notLoaded.home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(notLoaded.home, 'Library', 'LaunchAgents', `${name}.plist`), '<plist/>\n');
    expect(detectService(root, notLoaded.env)).toMatchObject({ mode: 'launchd', active: false });

    const noDomain = makeEnv('darwin', {
      [key]: { ok: false, status: 112, stderr: 'Could not find domain for user gui: 1000' },
    });
    fs.mkdirSync(path.join(noDomain.home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(noDomain.home, 'Library', 'LaunchAgents', `${name}.plist`), '<plist/>\n');
    expect(() => detectService(root, noDomain.env)).toThrow(/Could not find domain/);

    const loaded = makeEnv('darwin', { [key]: { ok: true, stdout: 'state = running' } });
    fs.mkdirSync(path.join(loaded.home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(loaded.home, 'Library', 'LaunchAgents', `${name}.plist`), '<plist/>\n');
    expect(detectService(root, loaded.env)).toMatchObject({ mode: 'launchd', active: true });
  });

  it('pgrep: exit 1 is nothing running, an unspawnable pgrep refuses (real runner)', () => {
    const root = temp();
    const runner = createCommandRunner();
    const { env } = makeEnv('linux');
    env.runner = runner;
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });

    env.runner = {
      run: (command, args, cwd) => runner.run(command === 'pgrep' ? 'pgrep-missing-zz' : command, args, cwd),
      tryRun: runner.tryRun,
    };
    expect(() => detectService(root, env)).toThrow(/pgrep.*ENOENT.*Install procps/s);
  });

  it('adopts /run/user/<uid> as XDG_RUNTIME_DIR only when unset and present', () => {
    const runRoot = temp();
    const saved = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBeUndefined();

      fs.mkdirSync(path.join(runRoot, '1000'));
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBe(path.join(runRoot, '1000'));

      process.env.XDG_RUNTIME_DIR = '/run/user/keep';
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBe('/run/user/keep');
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });
  it('verifyServiceHealth polls through a transient probe failure and reports a persistent one at the timeout', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const key = `systemctl --user is-active ${name}`;
    const { env, home } = makeEnv('linux', {
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    writeUserUnit(home, name);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'ncl.sock'), 'test socket stand-in');
    const handle = { mode: 'systemd-user' as const, active: true, name };
    let probes = 0;
    env.runner.run = (command, args) => {
      if (`${command} ${args.join(' ')}` !== key) return '';
      probes += 1;
      if (probes === 1) throw Object.assign(new Error('Command failed'), { status: 1, stderr: busError });
      return '';
    };
    await expect(verifyServiceHealth(handle, root, env, 5_000)).resolves.toBe(true);
    expect(probes).toBe(2);

    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      env.sleep = async () => {
        clock += 500;
      };
      env.runner.run = () => {
        throw Object.assign(new Error('Command failed'), { status: 1, stderr: busError });
      };
      await expect(verifyServiceHealth(handle, root, env, 2_000)).rejects.toThrow(/No medium found/);
    } finally {
      now.mockRestore();
    }
  });
});

describe('drain and health gates', () => {
  it('filters active containers by this install slug', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env, calls } = makeEnv('linux', {
      [`docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`]: { ok: true, stdout: '' },
    });

    await drainContainers(root, env);
    expect(calls).toEqual([`docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`]);
  });

  it('stops the labeled containers itself, then waits for the runtime to list none (#3828)', async () => {
    // The host is stopped before the drain and its SIGTERM path leaves idle
    // agent containers running on purpose, so a poll-only drain could never
    // succeed: the drain must be the thing that stops them.
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    let listings = 0;
    const { env, calls } = makeEnv('linux');
    env.runner.tryRun = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      if (key === ps) {
        listings += 1;
        // Listed twice with both up (before the stop and on the first poll), then empty.
        return { ok: true, stdout: listings <= 2 ? 'aaa111\nbbb222' : '' };
      }
      return { ok: true, stdout: '' };
    };
    const progress: string[] = [];
    env.log = (message) => progress.push(message);

    await drainContainers(root, env);
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111 bbb222`, ps, ps]);
    expect(progress).toEqual(['Stopping 2 NanoClaw container(s): aaa111, bbb222']);
  });

  it('keeps its inlined label contract equal to src/drivers/types.ts', () => {
    expect(DRAIN_LIST_FORMAT).toBe(`{{.ID}}|{{.Label "${LABELS.session}"}}|{{.Label "${LABELS.role}"}}`);
    expect(CONTROLLER_GATEWAY_ROLE).toBe(GATEWAY_ROLE);
  });

  it('leaves gateway-owned containers running through cutover', async () => {
    // A gateway's own container carries the install label and role=gateway but
    // no session; stopping it let the next host start reap it.
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    let stopped = false;
    const { env, calls } = makeEnv('linux');
    env.runner.tryRun = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      if (args[0] === 'stop') stopped = true;
      if (key === ps)
        return { ok: true, stdout: `${stopped ? '' : 'agent111|s1|agent\nbare444||agent\n'}gw222||gateway\n` };
      return { ok: true, stdout: '' };
    };

    await drainContainers(root, env);
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} agent111 bare444`, ps]);
  });

  it('still stops pre-seam containers (no session, no role)', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    const { env, calls } = makeEnv('linux', { [ps]: { ok: true, stdout: 'old333||\n' } });

    await expect(drainContainers(root, env, 0)).rejects.toThrow('old333');
    expect(calls).toContain(`docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} old333`);
  });

  it('restarts only gateway-owned containers after a snapshot restore, and never throws', () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps -a --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    const restart = `docker restart -t ${CUTOVER_STOP_GRACE_SECONDS} gw222`;
    const { env, calls } = makeEnv('linux', {
      [ps]: { ok: true, stdout: 'agent111|s1|agent\ngw222||gateway\nold333||\nbare444||agent\n' },
      [restart]: { ok: false, stdout: 'daemon error' },
    });
    const progress: string[] = [];
    env.log = (message) => progress.push(message);

    expect(() => restartGatewayContainers(root, env)).not.toThrow();
    expect(calls).toEqual([ps, restart]);
    expect(progress[1]).toContain('re-run the gateway');
  });

  it('tolerates a failed stop when the containers are gone anyway (exited between list and stop)', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    let listings = 0;
    const { env, calls } = makeEnv('linux');
    env.runner.tryRun = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      if (key === ps) {
        listings += 1;
        return { ok: true, stdout: listings === 1 ? 'aaa111' : '' };
      }
      if (args[0] === 'stop') return { ok: false, stdout: 'Error response from daemon: No such container: aaa111' };
      return { ok: true, stdout: '' };
    };

    await expect(drainContainers(root, env)).resolves.toBeUndefined();
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`, ps]);
  });

  it('still fails, naming the survivors and the stop error, when a container outlives the bound', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env } = makeEnv('linux', {
      [`docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`]: { ok: true, stdout: 'aaa111' },
      [`docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`]: { ok: false, stdout: 'permission denied' },
    });

    await expect(drainContainers(root, env, 0)).rejects.toThrow(
      'Timed out waiting for NanoClaw containers to stop: aaa111 (docker stop failed: permission denied)',
    );
  });

  it('a stalled `docker stop` counts against the drain bound and is itself bounded (review on #3873)', async () => {
    // The deadline starts BEFORE the stop call, and the stop call carries its
    // own subprocess timeout: a daemon that never answers cannot hold cutover
    // open indefinitely with the service down.
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const ps = `docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`;
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const { env, calls } = makeEnv('linux');
      const timeouts: Array<number | undefined> = [];
      env.sleep = async () => {
        clock += 1_000;
      };
      env.runner.tryRun = (command, args, _cwd, options) => {
        const key = `${command} ${args.join(' ')}`;
        calls.push(key);
        timeouts.push(options?.timeoutMs);
        if (args[0] === 'stop') {
          clock += CUTOVER_STOP_CLI_TIMEOUT_MS; // the CLI call ran into its own bound
          return { ok: false, stdout: 'ETIMEDOUT' };
        }
        return { ok: true, stdout: 'stuck333' };
      };

      await expect(drainContainers(root, env, 60_000)).rejects.toThrow(
        'Timed out waiting for NanoClaw containers to stop: stuck333 (docker stop failed: ETIMEDOUT)',
      );
      expect(calls[0]).toBe(ps);
      expect(calls[1]).toBe(`docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} stuck333`);
      // 30 s went to the stop, so the poll had only the remaining 30 s of the 60 s bound.
      expect(calls.length).toBeLessThanOrEqual(2 + 31);
      expect(timeouts[0]).toBe(CUTOVER_LIST_CLI_TIMEOUT_MS);
      expect(timeouts[1]).toBe(CUTOVER_STOP_CLI_TIMEOUT_MS);
      expect(CUTOVER_STOP_CLI_TIMEOUT_MS).toBeGreaterThan(CUTOVER_STOP_GRACE_SECONDS * 1_000 * 2);
    } finally {
      now.mockRestore();
    }
  });

  it('the real runner kills a subprocess that outlives its timeout and reports ETIMEDOUT', () => {
    const started = Date.now();
    const result = createCommandRunner().tryRun('sleep', ['30'], undefined, { timeoutMs: 200 });
    expect(result).toEqual({ ok: false, stdout: 'ETIMEDOUT' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails closed when the runtime cannot be queried', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env, calls } = makeEnv('linux', {
      [`docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`]: {
        ok: false,
        stdout: 'Cannot connect to the Docker daemon',
      },
    });

    await expect(drainContainers(root, env)).rejects.toThrow('Cannot inspect active NanoClaw containers with docker');
    expect(calls).toEqual([`docker ps --filter label=${label} --format ${DRAIN_LIST_FORMAT}`]);
  });

  it('requires active process state, the ncl socket, and a successful CLI probe', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active ${name}`]: { ok: true },
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'ncl.sock'), 'test socket stand-in');

    const healthy = await verifyServiceHealth(
      { mode: 'systemd-user', active: true, name, definition: unit },
      root,
      env,
      10,
    );
    expect(healthy).toBe(true);
  });
});

describe('command runner output capacity', () => {
  it('captures well over the 1 MiB default maxBuffer (ENOBUFS regression)', () => {
    // A full vitest run on a large repo exceeds Node's 1 MiB spawnSync default
    // and killed validate as `spawnSync pnpm ENOBUFS` before the tests were
    // ever judged.
    const runner = createCommandRunner();
    const out = runner.run('node', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
    expect(out.length).toBe(2 * 1024 * 1024);
  });
});

describe('controller main-module guard', () => {
  it('runs when invoked through a symlink-spelled path (macOS mktemp lives under /var → /private/var)', () => {
    // Before the realpath in the guard, a symlinked argv made the guard false
    // and the controller exited 0 having done nothing — silent success.
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
    const link = path.join(linkRoot, 'repo');
    fs.symlinkSync(path.resolve(__dirname, '..', '..'), link);
    try {
      const result = spawnSync('pnpm', ['exec', 'tsx', path.join(link, 'scripts', 'update-nanoclaw.ts')], {
        cwd: path.resolve(__dirname, '..', '..'),
        encoding: 'utf8',
        timeout: 60_000,
      });
      // Reaching main() at all means the guard held: no arguments is a loud
      // usage error (exit 1 + error JSON), never a silent empty exit 0.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('nanoclaw-update-error/v1');
      expect(result.stderr).toContain('Missing command');
    } finally {
      fs.rmSync(linkRoot, { recursive: true, force: true });
    }
  });
});

describe('stopService idempotency (already-stopped is success, per mode)', () => {
  const env = (runner: CommandRunner): ServiceEnvironment => ({
    platform: 'darwin',
    home: os.homedir(),
    uid: 501,
    runner,
    sleep: async () => {},
  });

  it('tolerates launchd bootout of a not-loaded job, in launchctl own words', async () => {
    const runner: CommandRunner = {
      run() {
        throw new Error('Command failed: launchctl bootout gui/501/x\nBoot-out failed: 3: No such process');
      },
      tryRun: () => ({ ok: true, stdout: '' }),
    };
    await expect(stopService({ mode: 'launchd', active: true, name: 'x' }, env(runner))).resolves.toBeUndefined();
  });

  it('still throws for any other launchd stop failure — the caller must abort before destroying anything', async () => {
    const runner: CommandRunner = {
      run() {
        throw new Error('Boot-out failed: 5: Input/output error');
      },
      tryRun: () => ({ ok: true, stdout: '' }),
    };
    await expect(stopService({ mode: 'launchd', active: true, name: 'x' }, env(runner))).rejects.toThrow(
      /Input\/output error/,
    );
  });

  it('tolerates ESRCH for a nohup pid that already exited', async () => {
    // A freshly-exited real pid; if the OS reused it in the microseconds
    // since spawnSync returned, kill() raises no ESRCH and the wait loop
    // fails loudly rather than the test passing vacuously.
    const dead = spawnSync('node', ['-e', '']);
    await expect(
      stopService(
        { mode: 'nohup', active: true, pid: dead.pid },
        env({ run: () => '', tryRun: () => ({ ok: true, stdout: '' }) }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('withRecordedNohupHost (nohup rollback stop target)', () => {
  function fixture() {
    const root = temp();
    const proc = temp();
    const env: ServiceEnvironment = {
      platform: 'linux',
      home: os.homedir(),
      uid: 1000,
      procRoot: proc,
      runner: { run: () => '', tryRun: () => ({ ok: true, stdout: '' }) },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const writeProc = (pid: number, argv: string[]) => {
      fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    };
    const host = (pid: number) => writeProc(pid, ['node', path.join(root, 'dist', 'index.js')]);
    const recordPid = (text: string) => fs.writeFileSync(path.join(root, 'nanoclaw.pid'), `${text}\n`);
    const captured = { mode: 'nohup' as const, active: true, definition: path.join(root, 'start-nanoclaw.sh') };
    return { root, env, host, writeProc, recordPid, captured };
  }

  it('stops the host recorded in nanoclaw.pid, not the dead pid captured before cutover', async () => {
    const { root, env, host, recordPid, captured } = fixture();
    const dead = spawnSync('node', ['-e', '']).pid;
    const live = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => live.once('exit', resolve));
    try {
      host(live.pid!);
      recordPid(String(live.pid));
      const handle = withRecordedNohupHost({ ...captured, pid: dead }, root, env);
      expect(handle).toEqual({ ...captured, pid: live.pid, active: true });
      await stopService(handle, env);
      await expect(exited).resolves.toBeDefined();
    } finally {
      live.kill('SIGKILL');
    }
  });

  it.each(['real path', 'symlink alias'])('matches a symlinked checkout when the launcher recorded the %s', (form) => {
    const { env, writeProc, captured } = fixture();
    const real = temp();
    const alias = path.join(temp(), 'nanoclaw');
    fs.symlinkSync(real, alias);
    fs.mkdirSync(path.join(real, 'dist'));
    fs.writeFileSync(path.join(real, 'dist', 'index.js'), '');
    const [recorded, projectRoot] = form === 'real path' ? [real, alias] : [alias, real];
    fs.writeFileSync(path.join(projectRoot, 'nanoclaw.pid'), '5151\n');
    writeProc(5151, ['node', path.join(recorded, 'dist', 'index.js')]);
    expect(withRecordedNohupHost({ ...captured, pid: 4242 }, projectRoot, env)).toMatchObject({
      pid: 5151,
      active: true,
    });
  });

  it('never targets a recorded pid that is not this checkout host (reused, relative, 0, -1, garbage)', () => {
    const { root, env, writeProc, recordPid, captured } = fixture();
    writeProc(4242, ['/usr/bin/sleep', '30']);
    writeProc(5151, ['node', 'dist/index.js']);
    writeProc(6161, ['tail', '-f', path.join(root, 'dist', 'index.js')]);
    for (const text of ['4242', '5151', '6161', '0', '-1', 'garbage']) {
      recordPid(text);
      expect(withRecordedNohupHost({ ...captured, pid: 4242 }, root, env)).toEqual({
        ...captured,
        pid: undefined,
        active: false,
      });
    }
  });

  it('logs whether it found a host to stop or none', () => {
    const { root, env, host, recordPid, captured } = fixture();
    const progress: string[] = [];
    env.log = (message) => progress.push(message);
    recordPid('5151');
    withRecordedNohupHost(captured, root, env);
    host(5151);
    withRecordedNohupHost(captured, root, env);
    expect(progress).toEqual([
      'No running NanoClaw host found for this checkout; nothing to stop',
      'Found running NanoClaw host (PID 5151); stopping it',
    ]);
  });

  it('detectService (cutover) treats a recorded pid reused by another process as not running', () => {
    const { root, env, writeProc, recordPid } = fixture();
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/bash\n');
    recordPid(String(process.pid));
    writeProc(process.pid, ['/usr/bin/sleep', '30']);
    expect(detectService(root, env)).toMatchObject({ mode: 'nohup', pid: process.pid, active: false });
    writeProc(process.pid, ['node', path.join(root, 'dist', 'index.js')]);
    expect(detectService(root, env)).toMatchObject({ mode: 'nohup', pid: process.pid, active: true });
  });

  it('leaves service-manager handles untouched', () => {
    const { root, env } = fixture();
    const handle = { mode: 'systemd-user' as const, active: true, name: 'nanoclaw-v2-x' };
    expect(withRecordedNohupHost(handle, root, env)).toBe(handle);
  });
});
