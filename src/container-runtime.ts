/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 * Detected from the bridge0 interface, falling back to 192.168.64.1.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  // Apple Container on macOS: containers reach the host via the bridge network gateway
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Fallback: Apple Container's default gateway
  return '192.168.64.1';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount.
 *
 * Uses `-v src:dst:ro` instead of `--mount type=bind` because Apple Container's
 * `--mount` rejects file (non-directory) sources ("path '...' is not a directory"),
 * while `-v` accepts both files and directories. Readonly is enforced for both.
 */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch {
    log.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      log.info('Container runtime started');
    } catch (err) {
      log.error('Failed to start container runtime', { err });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Apple Container is installed                        ║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', {
        cause: err,
      });
    }
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
    // Apple Container's `ls --filter label=...` is not supported, so we parse
    // the JSON output and filter client-side. We scope by install label so a
    // peer install on the same host cannot reap our containers (and vice
    // versa). If the runtime doesn't surface labels in JSON we fall back to
    // a name-prefix check.
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --all --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: Array<{
      status?: string;
      configuration?: { id?: string; labels?: Record<string, string> };
    }> = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => {
        if (c.status !== 'running') return false;
        const id = c.configuration?.id ?? '';
        const labels = c.configuration?.labels ?? {};
        const [labelKey, labelValue] = CONTAINER_INSTALL_LABEL.split('=');
        if (labels[labelKey]) return labels[labelKey] === labelValue;
        return id.startsWith('nanoclaw-');
      })
      .map((c) => c.configuration!.id!)
      .filter(Boolean);
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
