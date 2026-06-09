/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Currently targets Apple Container (macOS). Linux/Docker support was removed
 * during the v1→v2 Apple Container conversion.
 */
import { execSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Apple Container assigns the host gateway IP automatically inside the bridge
  // network. No extra args required.
  return [];
}

/** Returns CLI args for a readonly bind mount.
 *
 * Uses `-v src:dst:ro` (not `--mount type=bind,...`) because Apple Container's
 * `--mount` form rejects file sources — only directories are accepted. The
 * `-v` form works for both files and directories and honors `:ro`. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
    return;
  } catch {
    log.info('Container runtime not running, attempting to start...');
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
    log.info('Container runtime started');
  } catch (err) {
    log.error('Failed to start container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Apple Container is installed (brew install container)║');
    console.error('║  2. Run: container system start                                ║');
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
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --all --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    type ContainerRow = {
      status?: string;
      configuration?: { id?: string; labels?: Record<string, string> | { key: string; value: string }[] };
    };
    const rows: ContainerRow[] = output.trim() ? JSON.parse(output) : [];
    const orphans: string[] = [];
    for (const row of rows) {
      if (row.status !== 'running') continue;
      const id = row.configuration?.id;
      if (!id) continue;
      const labels = row.configuration?.labels;
      let matches = false;
      if (Array.isArray(labels)) {
        const [k, v] = CONTAINER_INSTALL_LABEL.split('=');
        matches = labels.some((l) => l.key === k && l.value === v);
      } else if (labels && typeof labels === 'object') {
        const [k, v] = CONTAINER_INSTALL_LABEL.split('=');
        matches = labels[k] === v;
      }
      if (matches) orphans.push(id);
    }
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
