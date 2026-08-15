/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, execFileSync } from 'child_process';
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

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * Force-remove a container by name (SIGKILL + rm). Stronger than
 * stopContainer's `docker stop -t 1` — reaps containers dockerd won't stop
 * gracefully (upstream #2659). Idempotent + best-effort.
 */
export function forceRemoveContainer(name: string): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], { stdio: 'pipe' });
  } catch {
    /* already gone */
  }
}

/**
 * Reap untracked NanoClaw containers for ONE agent-group folder. Lists running
 * containers whose name matches `nanoclaw-v2-<folder>-*` and force-removes any
 * NOT in `tracked` (the live activeContainers name set). Kills perceived-exit
 * orphans (host lost the child-process handle but dockerd kept the `--rm`
 * container alive) without touching legitimately-tracked containers.
 * NOTE: docker's name filter is a substring match — the `tracked` set (exact
 * names) is what protects live containers, so folder-name prefixing is safe.
 */
export function reapUntrackedForFolder(folder: string, tracked: Set<string>): string[] {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'ps',
        '--filter',
        `name=nanoclaw-v2-${folder}-`,
        '--filter',
        `label=${CONTAINER_INSTALL_LABEL}`,
        '--format',
        '{{.Names}}',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const reaped: string[] = [];
    for (const name of out.trim().split('\n').filter(Boolean)) {
      if (tracked.has(name)) continue;
      forceRemoveContainer(name);
      reaped.push(name);
    }
    return reaped;
  } catch {
    return [];
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
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
