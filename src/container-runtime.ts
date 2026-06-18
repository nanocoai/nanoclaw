/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Runtime is ENV-gated via CONTAINER_RUNTIME (docker | container). Apple Container
 * ('container') reaches the host via the bridge gateway (192.168.64.x); Docker uses
 * the built-in host.docker.internal.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_RUNTIME, CONTAINER_INSTALL_LABEL, INSTALL_SLUG, NANOCLAW_HOST_GATEWAY_IP } from './config.js';
import { log } from './log.js';

/** The container runtime binary name ('docker' | 'container'). */
export const CONTAINER_RUNTIME_BIN = CONTAINER_RUNTIME;
export const IS_APPLE_CONTAINER = CONTAINER_RUNTIME_BIN === 'container';

/**
 * Bridge gateway IP that Apple Container VMs use to reach the host.
 * bridge100 is vmnet-managed (192.168.64.x); the host is at the gateway (.1).
 * We extract the bridge100 (or bridge0) IPv4 in the host-only 192.168.64.0/24
 * subnet; if none is found the env override then the conventional .1 win.
 * Uses `||` (not `??`) so an unset override — which config.ts normalises to the
 * empty string, NOT null — still falls through to the .1 literal default.
 */
export function detectHostGateway(): string {
  const ni = os.networkInterfaces();
  const ifaces = ni['bridge100'] ?? ni['bridge0'] ?? [];
  const addr = ifaces.find((a) => a.family === 'IPv4' && a.address.startsWith('192.168.64.'))?.address;
  return addr || NANOCLAW_HOST_GATEWAY_IP || '192.168.64.1';
}

/**
 * Address containers use to reach the host, resolved LAZILY at call time.
 * Docker has built-in host.docker.internal; Apple Container has none, so we
 * resolve to the bridge gateway IP — and crucially do so AFTER the runtime has
 * brought bridge100 up (callers run at spawn time), never as a frozen
 * import-time constant that would capture an empty value on a cold boot.
 */
export function getHostGateway(): string {
  return IS_APPLE_CONTAINER ? detectHostGateway() : 'host.docker.internal';
}
if (IS_APPLE_CONTAINER) {
  // Resolve the gateway lazily per spawn (the bridge may not be up yet at import),
  // so log only the override here — never an eager import-time detection.
  log.info('Apple Container runtime selected', { hostGatewayOverride: NANOCLAW_HOST_GATEWAY_IP || '(autodetect)' });
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Docker on Linux needs an explicit host.docker.internal mapping; macOS Docker
  // Desktop and Apple Container do not (Apple resolution is handled by rewriting
  // host.docker.internal literals in injected env values, not --add-host, which
  // Apple Container's `run` does not support).
  if (!IS_APPLE_CONTAINER && os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. `-v src:dst:ro` works on both runtimes. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Both runtimes support `stop -t 1` (SIGTERM grace window). */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

function fatalBanner(lines: string[]): void {
  const W = 64;
  console.error('\n╔' + '═'.repeat(W) + '╗');
  for (const l of lines) console.error('║  ' + l.padEnd(W - 3) + '║');
  console.error('╚' + '═'.repeat(W) + '╝\n');
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (IS_APPLE_CONTAINER) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe', timeout: 10000 });
      log.debug('Apple Container runtime already running');
    } catch {
      log.info('Starting Apple Container runtime...');
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
        log.info('Apple Container runtime started');
      } catch (err) {
        log.error('Failed to start Apple Container runtime', { err });
        fatalBanner([
          'FATAL: Apple Container runtime failed to start',
          '',
          '1. Ensure Apple Container is installed (brew install container)',
          '2. Run: container system start',
          '3. Restart NanoClaw',
        ]);
        throw new Error('Container runtime is required but failed to start', { cause: err });
      }
    }
    // Bring the builder (and bridge100 / 192.168.64.1) up before the OneCLI forwarder binds.
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} builder status`, { stdio: 'pipe', timeout: 10000 });
    } catch {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} builder start`, { stdio: 'pipe', timeout: 30000 });
        log.info('Apple Container builder started (bridge network up)');
      } catch (err) {
        log.warn('Apple Container builder start failed — bridge100 may not be up yet', { err });
      }
    }
    return;
  }

  // Docker
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    fatalBanner([
      'FATAL: Container runtime failed to start',
      '',
      'Agents cannot run without a container runtime. To fix:',
      '1. Ensure Docker is installed and running',
      '2. Run: docker info',
      '3. Restart NanoClaw',
    ]);
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}

function stopOrphans(orphans: string[]): void {
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
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. Apple Container's
 * `ls --format json` exposes labels at `configuration.labels` and state at
 * `status.state`, so the slug-scoping is preserved under both runtimes.
 */
export function cleanupOrphans(): void {
  try {
    if (IS_APPLE_CONTAINER) {
      const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --all --format json`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: {
        id: string;
        status?: { state?: string };
        configuration?: { labels?: Record<string, string> };
      }[] = JSON.parse(output || '[]');
      const orphans = containers
        .filter((c) => c.status?.state === 'running' && c.configuration?.labels?.['nanoclaw-install'] === INSTALL_SLUG)
        .map((c) => c.id);
      stopOrphans(orphans);
      return;
    }

    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    stopOrphans(output.trim().split('\n').filter(Boolean));
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
