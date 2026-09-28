import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getInstallSlug } from '../../src/install-slug.js';

export interface RunOptions {
  /** Kill the subprocess and fail the call after this long. Unset = no bound. */
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd?: string, options?: RunOptions): string;
  tryRun(command: string, args: string[], cwd?: string, options?: RunOptions): { ok: boolean; stdout: string };
}

export function createCommandRunner(): CommandRunner {
  const run = (command: string, args: string[], cwd?: string, options?: RunOptions): string =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options?.timeoutMs,
      // Node's default maxBuffer is 1 MiB; a full vitest run on a large repo
      // exceeds it and the whole validate step dies as `spawnSync pnpm
      // ENOBUFS` with the tests never judged. 64 MiB is far above any real
      // build/test output while still bounding a runaway.
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  return {
    run,
    tryRun(command, args, cwd, options) {
      try {
        return { ok: true, stdout: run(command, args, cwd, options) };
      } catch (err) {
        const failed = err as { code?: string; stdout?: Buffer | string; stderr?: Buffer | string };
        const output = [failed.stdout, failed.stderr]
          .map((part) => part?.toString().trim())
          .filter(Boolean)
          .join('\n');
        // A timed-out or unspawnable command has no output of its own; the
        // error code (ETIMEDOUT, ENOENT) is the only thing worth reporting.
        return { ok: false, stdout: output || (failed.code ? String(failed.code) : '') };
      }
    },
  };
}

export type ServiceMode = 'launchd' | 'systemd-user' | 'systemd-system' | 'nohup' | 'unmanaged' | 'none';

export interface ServiceHandle {
  mode: ServiceMode;
  active: boolean;
  name?: string;
  definition?: string;
  pid?: number;
}

export interface ServiceEnvironment {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  runner: CommandRunner;
  sleep(ms: number): Promise<void>;
  /** Progress line for a wait the operator would otherwise read as a hang. */
  log?(message: string): void;
  /** procfs mount for nohup host identity checks; tests point it at a fixture. */
  procRoot?: string;
}

export function defaultServiceEnvironment(runner = createCommandRunner()): ServiceEnvironment {
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    runner,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // stderr: stdout carries the controller's JSON result.
    log: (message) => process.stderr.write(`[update] ${message}\n`),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nohupPidFile(projectRoot: string): string {
  return path.join(projectRoot, 'nanoclaw.pid');
}

function readNohupPid(projectRoot: string): number | undefined {
  try {
    const text = fs.readFileSync(nohupPidFile(projectRoot), 'utf8').trim();
    // Positive only: `kill` with 0 or a negative pid signals a process group.
    return /^[1-9][0-9]*$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// start-nanoclaw.sh's is_previous_host test, allowing node options before the
// script: node with this checkout's absolute entrypoint among its arguments.
// 'unknown' when a live process's command line cannot be read.
function nohupHostIdentity(pid: number, projectRoot: string, env: ServiceEnvironment): 'host' | 'other' | 'unknown' {
  let args: string[];
  try {
    args = fs.readFileSync(path.join(env.procRoot ?? '/proc', String(pid), 'cmdline'), 'utf8').split('\0');
  } catch {
    return processExists(pid) ? 'unknown' : 'other';
  }
  const entrypoint = path.join(projectRoot, 'dist', 'index.js');
  const accepted = new Set([entrypoint]);
  try {
    accepted.add(fs.realpathSync(entrypoint));
  } catch {
    // Not built: only the literal path can match.
  }
  const isNode = /^node/.test(path.basename(args[0] ?? ''));
  return isNode && args.slice(1).some((arg) => accepted.has(arg)) ? 'host' : 'other';
}

/**
 * The host a nohup stop must reach now. A captured handle holds whichever pid
 * ran at capture; start-nanoclaw.sh records later starts only in nanoclaw.pid,
 * and a failed pid write records none. So scan procfs and signal only a pid
 * proven to be this checkout's host (a stale pid may be reused). Anything
 * unprovable or several hosts become an unmanaged handle, which stopService
 * refuses before any reset.
 */
export function resolveNohupHost(handle: ServiceHandle, projectRoot: string, env: ServiceEnvironment): ServiceHandle {
  if (handle.mode !== 'nohup') return handle;
  const known = [readNohupPid(projectRoot), handle.pid].filter((pid): pid is number => pid !== undefined);
  let entries: string[];
  try {
    entries = fs.readdirSync(env.procRoot ?? '/proc');
  } catch {
    entries = [];
  }
  const scanned = entries.filter((entry) => /^[1-9][0-9]*$/.test(entry)).map(Number);
  if (scanned.length === 0) {
    // No procfs, so no way to prove identity: refuse rather than guess.
    const live = known.filter(processExists);
    return live.length ? { mode: 'unmanaged', active: true, name: live.join(',') } : { ...handle, active: false };
  }
  const unknown = known.filter((pid) => nohupHostIdentity(pid, projectRoot, env) === 'unknown');
  if (unknown.length) return { mode: 'unmanaged', active: true, name: unknown.join(',') };
  const hosts = [...new Set([...known, ...scanned])]
    .filter((pid) => nohupHostIdentity(pid, projectRoot, env) === 'host')
    .sort((x, y) => x - y);
  if (hosts.length > 1) return { mode: 'unmanaged', active: true, name: hosts.join(',') };
  if (hosts.length === 1) return { ...handle, pid: hosts[0], active: true };
  return { ...handle, pid: undefined, active: false };
}

export function detectService(projectRoot: string, env: ServiceEnvironment): ServiceHandle {
  const slug = getInstallSlug(projectRoot);
  if (env.platform === 'darwin') {
    const name = `com.nanoclaw-v2-${slug}`;
    const definition = path.join(env.home, 'Library', 'LaunchAgents', `${name}.plist`);
    if (fs.existsSync(definition)) {
      return {
        mode: 'launchd',
        name,
        definition,
        active: env.runner.tryRun('launchctl', ['print', `gui/${env.uid}/${name}`]).ok,
      };
    }
  }

  if (env.platform === 'linux') {
    const name = `nanoclaw-v2-${slug}`;
    const userDefinition = path.join(env.home, '.config', 'systemd', 'user', `${name}.service`);
    const systemDefinition = `/etc/systemd/system/${name}.service`;
    if (fs.existsSync(userDefinition)) {
      return {
        mode: 'systemd-user',
        name,
        definition: userDefinition,
        active: env.runner.tryRun('systemctl', ['--user', 'is-active', '--quiet', name]).ok,
      };
    }
    if (fs.existsSync(systemDefinition)) {
      return {
        mode: 'systemd-system',
        name,
        definition: systemDefinition,
        active: env.runner.tryRun('systemctl', ['is-active', '--quiet', name]).ok,
      };
    }

    const definition = path.join(projectRoot, 'start-nanoclaw.sh');
    if (fs.existsSync(definition) && fs.existsSync(nohupPidFile(projectRoot))) {
      const pid = readNohupPid(projectRoot);
      return { mode: 'nohup', definition, pid, active: pid !== undefined && processExists(pid) };
    }
  }

  const unmanaged = env.runner.tryRun('pgrep', ['-f', `${escapeRegex(projectRoot)}/(dist/index\\.js|src/index\\.ts)`]);
  if (unmanaged.ok && unmanaged.stdout) {
    return { mode: 'unmanaged', active: true, name: unmanaged.stdout.split('\n').join(',') };
  }
  return { mode: 'none', active: false };
}

/**
 * Idempotent per mode: stopping an already-stopped service is success, in the
 * service manager's own vocabulary — `launchctl bootout` fails a not-loaded
 * job with "No such process", `process.kill` raises ESRCH, and `systemctl
 * stop` of a stopped-but-loaded unit already exits 0. The rollback path stops
 * a handle captured before cutover (which stopped the service itself), so
 * without this the restore died on its own stop and left the live checkout on
 * the target commit with the service down. Any OTHER stop failure still
 * throws: a service that is genuinely still running must abort the caller
 * before anything is destroyed.
 */
export async function stopService(handle: ServiceHandle, env: ServiceEnvironment): Promise<void> {
  if (!handle.active) return;
  if (handle.mode === 'launchd') {
    try {
      env.runner.run('launchctl', ['bootout', `gui/${env.uid}/${handle.name}`]);
    } catch (err) {
      if (!/No such process/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  } else if (handle.mode === 'systemd-user') {
    env.runner.run('systemctl', ['--user', 'stop', handle.name!]);
  } else if (handle.mode === 'systemd-system') {
    env.runner.run('systemctl', ['stop', handle.name!]);
  } else if (handle.mode === 'nohup' && handle.pid) {
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      return;
    }
    for (let i = 0; i < 60 && processExists(handle.pid); i += 1) await env.sleep(500);
    if (processExists(handle.pid)) throw new Error(`NanoClaw process ${handle.pid} did not stop`);
  } else if (handle.mode === 'unmanaged') {
    throw new Error(
      `NanoClaw is running outside a supported service wrapper (PID ${handle.name}). Stop it, then retry cutover`,
    );
  }
}

export function startService(handle: ServiceHandle, projectRoot: string, env: ServiceEnvironment): void {
  if (!handle.active) return;
  if (handle.mode === 'launchd') {
    env.runner.run('launchctl', ['bootstrap', `gui/${env.uid}`, handle.definition!]);
    env.runner.run('launchctl', ['kickstart', `gui/${env.uid}/${handle.name}`]);
  } else if (handle.mode === 'systemd-user') {
    env.runner.run('systemctl', ['--user', 'start', handle.name!]);
  } else if (handle.mode === 'systemd-system') {
    env.runner.run('systemctl', ['start', handle.name!]);
  } else if (handle.mode === 'nohup') {
    env.runner.run('bash', [handle.definition!], projectRoot);
  }
}

/**
 * Grace between cutover's `stop` and the runtime's SIGKILL. Longer than the
 * host's own 1 s (`STOP_GRACE_SECONDS` in container-runner.ts): a customized
 * image that does handle SIGTERM gets a real window to flush, and a stock one
 * that ignores it costs nothing extra beyond these seconds.
 */
export const CUTOVER_STOP_GRACE_SECONDS = 10;

/**
 * Bound on the `docker stop` CLI call itself. `-t` only bounds how long the
 * container gets before the daemon SIGKILLs it; a daemon that never answers
 * would otherwise block the (synchronous) call forever, and cutover would sit
 * with the service down and never reach its rollback path. Comfortably above
 * the grace so a healthy stop is never cut short.
 */
export const CUTOVER_STOP_CLI_TIMEOUT_MS = 30_000;

/** Bound on each `docker ps` poll, for the same reason. */
export const CUTOVER_LIST_CLI_TIMEOUT_MS = 15_000;

/** Copies of `LABELS` and `GATEWAY_ROLE` (src/drivers/types.ts); a test pins them equal. */
export const DRAIN_LIST_FORMAT = '{{.ID}}|{{.Label "nanoclaw-session"}}|{{.Label "nanoclaw-role"}}';
export const CONTROLLER_GATEWAY_ROLE = 'gateway';

/**
 * Stop this install's containers, then wait until the runtime lists none.
 *
 * The host is the only thing that ever stops an idle agent container: it keeps
 * them alive between turns by design, and its SIGTERM path leaves them running
 * so the next start can adopt them. `cutoverUpdate` stops the host before
 * calling this, so a poll-only drain waited on an exit nothing could produce
 * and timed out five minutes later with the service already down (#3828).
 *
 * Stopping here, after the service is down, is race-free: nothing is left that
 * could spawn a replacement (the manual `docker stop` before cutover was not).
 * The filter is the install label (agent containers plus per-session
 * auxiliaries) minus gateway-owned ones (role=gateway, no session): nothing
 * recreates those at host start. Same rule as `isGatewayOwned` in
 * src/drivers/types.ts, inlined to keep the controller's imports small.
 *
 * A container mid-turn is stopped as well. The agent-runner has no SIGTERM
 * handler and the controller cannot read turn state from outside the host
 * DB, so waiting would not preserve the turn, and the update rebuilds the
 * image that container came from anyway. A non-zero `stop` is not fatal on
 * its own (a container that exited between the list and the stop makes
 * `docker stop` fail for that id while the rest still stop); only a
 * container still listed at the timeout is, and the caller restores the old
 * service.
 */
export async function drainContainers(projectRoot: string, env: ServiceEnvironment, timeoutMs = 60_000): Promise<void> {
  const runtime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const label = `nanoclaw-install=${getInstallSlug(projectRoot)}`;
  const list = (): { ok: boolean; ids: string[] } => {
    const listed = env.runner.tryRun(
      runtime,
      ['ps', '--filter', `label=${label}`, '--format', DRAIN_LIST_FORMAT],
      undefined,
      { timeoutMs: CUTOVER_LIST_CLI_TIMEOUT_MS },
    );
    const ids = listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('|'))
      .filter(([, sessionId, role]) => !!sessionId || role !== CONTROLLER_GATEWAY_ROLE)
      .map(([id]) => id);
    return { ok: listed.ok, ids };
  };
  const initial = list();
  if (!initial.ok) throw new Error(`Cannot inspect active NanoClaw containers with ${runtime}`);
  if (initial.ids.length === 0) return;

  // One deadline for stop AND poll: the clock starts before the stop call, so
  // a slow or stalled stop eats into the bound instead of extending it.
  const started = Date.now();
  env.log?.(`Stopping ${initial.ids.length} NanoClaw container(s): ${initial.ids.join(', ')}`);
  const stopped = env.runner.tryRun(
    runtime,
    ['stop', '-t', String(CUTOVER_STOP_GRACE_SECONDS), ...initial.ids],
    undefined,
    { timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS },
  );
  while (true) {
    const current = list();
    if (!current.ok) throw new Error(`Cannot inspect active NanoClaw containers with ${runtime}`);
    if (current.ids.length === 0) return;
    if (Date.now() - started >= timeoutMs) {
      const detail = stopped.ok ? '' : ` (${runtime} stop failed: ${stopped.stdout || 'no output'})`;
      throw new Error(`Timed out waiting for NanoClaw containers to stop: ${current.ids.join(', ')}${detail}`);
    }
    await env.sleep(1_000);
  }
}

/**
 * Restart this install's gateway-owned containers (see drainContainers).
 * A snapshot restore replaces `data/`, and a container's bind mounts keep
 * pointing at the deleted directories until it restarts. Stopped ones are
 * included so a retried rollback recovers a restart that failed halfway.
 * Best effort: throwing here would leave the service down, so a failure is
 * logged with the recovery step instead.
 */
export function restartGatewayContainers(projectRoot: string, env: ServiceEnvironment): void {
  const runtime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const label = `nanoclaw-install=${getInstallSlug(projectRoot)}`;
  const listed = env.runner.tryRun(
    runtime,
    ['ps', '-a', '--filter', `label=${label}`, '--format', DRAIN_LIST_FORMAT],
    undefined,
    { timeoutMs: CUTOVER_LIST_CLI_TIMEOUT_MS },
  );
  const ids = listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'))
    .filter(([, sessionId, role]) => !sessionId && role === CONTROLLER_GATEWAY_ROLE)
    .map(([id]) => id);
  if (!listed.ok) {
    env.log?.(`Cannot list gateway containers with ${runtime}; restart them or re-run the gateway's setup script.`);
    return;
  }
  if (ids.length === 0) return;
  env.log?.(`Restarting ${ids.length} gateway container(s) onto the restored data/: ${ids.join(', ')}`);
  const restarted = env.runner.tryRun(
    runtime,
    ['restart', '-t', String(CUTOVER_STOP_GRACE_SECONDS), ...ids],
    undefined,
    { timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS },
  );
  if (!restarted.ok) {
    env.log?.(`Gateway restart failed (${restarted.stdout || 'no output'}); re-run the gateway's setup script.`);
  }
}

export async function verifyServiceHealth(
  handle: ServiceHandle,
  projectRoot: string,
  env: ServiceEnvironment,
  timeoutMs = 60_000,
): Promise<boolean> {
  if (!handle.active) return true;
  const socket = path.join(projectRoot, 'data', 'ncl.sock');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = detectService(projectRoot, env);
    if (current.active && fs.existsSync(socket)) {
      if (env.runner.tryRun(path.join(projectRoot, 'bin', 'ncl'), ['groups', 'list'], projectRoot).ok) return true;
    }
    await env.sleep(500);
  }
  return false;
}
