/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
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
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
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
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// --- Watchdog: retry in the background instead of crashing the process ---

const HEALTHY_POLL_MS = 2 * 60 * 1000; // interval between checks while healthy
const DOWN_RETRY_BASE_MS = 30 * 1000; // first retry, 30s after going down
const DOWN_RETRY_MAX_MS = 5 * 60 * 1000; // backoff cap while down
const DOWN_NOTIFY_THRESHOLD_MS = 5 * 60 * 1000; // notify once down this long

let runtimeAvailable = true;

/** Whether the container runtime was reachable at last check. */
export function isContainerRuntimeAvailable(): boolean {
  return runtimeAvailable;
}

/** Quiet reachability probe for the watchdog's repeated checks — no banner, no throw. */
function probeRuntimeReachable(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort attempt to launch the container runtime's desktop app.
 * Swallows all errors — this is a convenience nudge, not a guarantee.
 */
export function tryLaunchContainerRuntime(): void {
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      const dockerDesktopPath =
        'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
      if (fs.existsSync(dockerDesktopPath)) {
        spawn(dockerDesktopPath, [], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        logger.info('Attempting to auto-launch Docker Desktop');
      }
    } else if (platform === 'darwin') {
      spawn('open', ['-a', 'Docker'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      logger.info('Attempting to auto-launch Docker Desktop');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to auto-launch container runtime');
  }
}

export interface ContainerRuntimeWatchdogOpts {
  /** Called once, the first time the runtime has been down past DOWN_NOTIFY_THRESHOLD_MS. */
  onDown: () => void;
  /** Called once, when the runtime recovers after onDown has fired. */
  onRecovered: () => void;
  /** Whether the runtime was already found down at startup. */
  initiallyDown: boolean;
}

/**
 * Watches the container runtime in the background: retries with backoff while
 * down, makes one best-effort attempt to launch it, and reports sustained
 * outages/recovery via callbacks — instead of crashing the whole process like
 * a single failed startup check used to.
 */
export function startContainerRuntimeWatchdog(
  opts: ContainerRuntimeWatchdogOpts,
): void {
  let consecutiveErrors = 0;
  let downSince: number | null = null;
  let notifiedDown = false;

  const scheduleHealthyCheck = () => setTimeout(checkHealthy, HEALTHY_POLL_MS);

  function checkHealthy(): void {
    if (probeRuntimeReachable()) {
      scheduleHealthyCheck();
    } else {
      enterDownState();
    }
  }

  function enterDownState(): void {
    runtimeAvailable = false;
    downSince = Date.now();
    consecutiveErrors = 0;
    logger.error(
      'Container runtime unreachable — agent tasks will queue until it recovers',
    );
    tryLaunchContainerRuntime();
    scheduleRetry();
  }

  function scheduleRetry(): void {
    const delayMs = Math.min(
      DOWN_RETRY_BASE_MS * Math.pow(2, consecutiveErrors),
      DOWN_RETRY_MAX_MS,
    );
    setTimeout(retryCheck, delayMs);
  }

  function retryCheck(): void {
    if (probeRuntimeReachable()) {
      cleanupOrphans();
      runtimeAvailable = true;
      downSince = null;
      consecutiveErrors = 0;
      logger.info('Container runtime recovered');
      if (notifiedDown) {
        notifiedDown = false;
        opts.onRecovered();
      }
      scheduleHealthyCheck();
      return;
    }

    consecutiveErrors++;
    logger.warn({ consecutiveErrors }, 'Container runtime still unavailable');
    if (
      downSince !== null &&
      !notifiedDown &&
      Date.now() - downSince >= DOWN_NOTIFY_THRESHOLD_MS
    ) {
      notifiedDown = true;
      opts.onDown();
    }
    scheduleRetry();
  }

  if (opts.initiallyDown) {
    enterDownState();
  } else {
    scheduleHealthyCheck();
  }
}
