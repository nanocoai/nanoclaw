/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL, ONECLI_URL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Cached result of rootless-podman detection. */
let _isRootlessPodman: boolean | null = null;

/** Detect whether the runtime is rootless Podman (needs --userns=keep-id). */
export function isRootlessPodman(): boolean {
  if (_isRootlessPodman !== null) return _isRootlessPodman;
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.Host.Security.Rootless}}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    _isRootlessPodman = out === 'true';
  } catch {
    _isRootlessPodman = false;
  }
  return _isRootlessPodman;
}

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Resolve the IP address that `host.docker.internal` should map to inside
 * containers. When OneCLI runs on a remote host, `host-gateway` (which
 * resolves to the container host) is wrong — the container must reach the
 * OneCLI gateway on the remote host directly.
 */
function resolveHostDockerTarget(): string {
  if (!ONECLI_URL) return 'host-gateway';
  try {
    const hostname = new URL(ONECLI_URL).hostname;
    if (LOCALHOST_NAMES.has(hostname)) return 'host-gateway';
    // Resolve the hostname to an IP for --add-host (hostnames aren't allowed).
    // Use execFileSync to avoid shell injection.
    const resolved = execFileSync('getent', ['hosts', hostname], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim().split(/\s+/)[0];
    return resolved || 'host-gateway';
  } catch {
    return 'host-gateway';
  }
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly.
  // When OneCLI runs on a remote host, map to that host's IP instead of
  // host-gateway (which points to the local container host).
  if (os.platform() === 'linux') {
    const target = resolveHostDockerTarget();
    return [`--add-host=host.docker.internal:${target}`];
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
