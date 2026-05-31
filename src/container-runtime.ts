/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Last-resort teardown for hosts where the daemon can't signal containers.
 *
 * On some setups — notably docker running inside an unprivileged LXC/VM —
 * the daemon (even as root) is denied the ability to signal container PIDs:
 * `docker stop`/`kill` return "permission denied" and the container keeps
 * running forever, so orphans accumulate across host restarts. Our agent
 * containers run PID 1 as the host user, so we can signal that PID directly
 * from the host; the kernel allows same-uid kills. Returns true if the
 * container's host PID was found and signalled.
 */
function killByHostPid(name: string): boolean {
  try {
    const pidStr = execSync(`${CONTAINER_RUNTIME_BIN} inspect --format '{{.State.Pid}}' ${name}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
  } catch (err) {
    // The daemon refused to stop it (e.g. docker-in-LXC "permission denied").
    // Fall back to signalling the container's host-side PID directly. If that
    // also fails, rethrow so callers see the real failure instead of a no-op.
    if (!killByHostPid(name)) throw err;
  }
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const name of orphans) {
      try {
        stopContainer(name);
        stopped.push(name);
      } catch {
        failed.push(name);
      }
    }
    if (stopped.length > 0) {
      log.info('Stopped orphaned containers', { count: stopped.length, names: stopped });
    }
    if (failed.length > 0) {
      // These will keep polling the session DB and racing live containers —
      // surface loudly rather than masking as "already stopped".
      log.error('Failed to stop orphaned containers — they are still running', {
        count: failed.length,
        names: failed,
      });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
