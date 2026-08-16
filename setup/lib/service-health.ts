import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { SocketTransport } from '../../src/cli/socket-client.js';
import type { ResponseFrame } from '../../src/cli/frame.js';
import type { HostHealth, HealthResource } from '../../src/health.js';
import type { SetupReceipt } from './setup-driver.js';
import { getPlatform, getServiceManager, isRoot } from '../platform.js';

export type ServiceState = 'running' | 'stopped' | 'not_found' | 'running_other_checkout' | 'identity_unknown';

export type ServiceCheck = {
  state: ServiceState;
  manager: 'launchd' | 'systemd-user' | 'systemd-system' | 'pidfile';
  pid?: number;
  checkoutRoot?: string;
  reason?: string;
};

export type ReceiptBuildResult =
  | { ok: true; receipt: SetupReceipt }
  | { ok: false; code: 'service_identity_unproven' | 'health_postcondition_failed'; message: string };

type Exec = (file: string, args: string[]) => string;

const run: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8' });

/** Inspect the install-owned service without trusting a human status string. */
export function inspectService(projectRoot: string, execute: Exec = run): ServiceCheck {
  const root = path.resolve(projectRoot);
  const manager = serviceManager();
  if (manager === 'launchd') return inspectLaunchd(root, execute);
  if (manager === 'systemd-user' || manager === 'systemd-system') return inspectSystemd(root, manager, execute);
  return inspectPidfile(root, execute);
}

export async function queryHostHealth(
  projectRoot: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HostHealth | null> {
  const socketPath = path.join(path.resolve(projectRoot), 'data', 'ncl.sock');
  let response: ResponseFrame;
  try {
    response = await new SocketTransport(socketPath).sendFrame(
      { id: randomUUID(), command: 'health', args: {} },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 1_000, maxResponseBytes: 256 * 1024 },
    );
  } catch {
    return null;
  }
  if (!response.ok || !isHostHealth(response.data)) return null;
  return response.data;
}

export function buildSetupReceipt(
  projectRoot: string,
  service: ServiceCheck,
  health: HostHealth | null,
): ReceiptBuildResult {
  const checkoutRoot = path.resolve(projectRoot);
  if (service.state !== 'running' || service.checkoutRoot !== checkoutRoot || service.pid === undefined) {
    return {
      ok: false,
      code: 'service_identity_unproven',
      message:
        service.state === 'running_other_checkout'
          ? 'NanoClaw is running from a different checkout.'
          : 'NanoClaw service identity could not be proven.',
    };
  }
  if (
    !health ||
    health.status !== 'healthy' ||
    health.checkoutRoot !== checkoutRoot ||
    health.process.cwd !== checkoutRoot ||
    health.process.pid !== service.pid
  ) {
    return {
      ok: false,
      code: 'health_postcondition_failed',
      message: 'NanoClaw service is running, but structured health could not prove this checkout is healthy.',
    };
  }
  return {
    ok: true,
    receipt: {
      version: 1,
      service: { state: 'running', manager: service.manager, checkoutRoot },
      health: { status: 'healthy' },
      resources: health.resources,
      completedAt: new Date().toISOString(),
    },
  };
}

function serviceManager(): ServiceCheck['manager'] {
  if (getPlatform() === 'macos') return 'launchd';
  if (getServiceManager() === 'systemd') return isRoot() ? 'systemd-system' : 'systemd-user';
  return 'pidfile';
}

function inspectLaunchd(root: string, execute: Exec): ServiceCheck {
  const manager = 'launchd' as const;
  const label = getLaunchdLabel(root);
  let output: string;
  try {
    output = execute('launchctl', ['list']);
  } catch {
    return { state: 'identity_unknown', manager, reason: 'launchctl_unavailable' };
  }
  const line = output.split('\n').find((candidate) => candidate.trim().split(/\s+/).at(-1) === label);
  if (!line) return { state: 'not_found', manager };
  const pidText = line.trim().split(/\s+/)[0];
  if (pidText === '-') return { state: 'stopped', manager };
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'identity_unknown', manager, reason: 'invalid_launchd_pid' };
  return finishIdentity(manager, pid, root, execute);
}

function inspectSystemd(root: string, manager: 'systemd-user' | 'systemd-system', execute: Exec): ServiceCheck {
  const unit = getSystemdUnit(root);
  const command = manager === 'systemd-system' ? 'systemctl' : 'systemctl';
  const prefix = manager === 'systemd-system' ? [] : ['--user'];
  try {
    execute(command, [...prefix, 'is-active', unit]);
  } catch {
    return { state: 'stopped', manager };
  }
  let pidText: string;
  try {
    pidText = execute(command, [...prefix, 'show', unit, '-p', 'MainPID', '--value']).trim();
  } catch {
    return { state: 'identity_unknown', manager, reason: 'systemd_pid_unavailable' };
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'identity_unknown', manager, reason: 'invalid_systemd_pid' };
  return finishIdentity(manager, pid, root, execute);
}

function inspectPidfile(root: string, execute: Exec): ServiceCheck {
  const manager = 'pidfile' as const;
  const pidPath = path.join(root, 'nanoclaw.pid');
  let pidText: string;
  try {
    pidText = fs.readFileSync(pidPath, 'utf8').trim();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'not_found', manager }
      : { state: 'identity_unknown', manager, reason: 'pidfile_unreadable' };
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'identity_unknown', manager, reason: 'invalid_pidfile_pid' };
  try {
    process.kill(pid, 0);
  } catch {
    return { state: 'stopped', manager, pid };
  }
  return finishIdentity(manager, pid, root, execute);
}

function finishIdentity(
  manager: ServiceCheck['manager'],
  pid: number,
  expectedRoot: string,
  execute: Exec,
): ServiceCheck {
  const actualRoot = resolveProcessCheckout(pid, expectedRoot, execute);
  if (!actualRoot) return { state: 'identity_unknown', manager, pid, reason: 'process_checkout_unavailable' };
  return {
    state: actualRoot === expectedRoot ? 'running' : 'running_other_checkout',
    manager,
    pid,
    checkoutRoot: actualRoot,
  };
}

function resolveProcessCheckout(pid: number, expectedRoot: string, execute: Exec): string | null {
  const script = resolveProcessScript(pid, expectedRoot, execute);
  if (!script) return null;
  return path.resolve(script, '..', '..');
}

function resolveProcessScript(pid: number, expectedRoot: string, execute: Exec): string | null {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const script = args.find((arg) => /\/dist\/index\.(?:js|mjs|cjs|ts)$/.test(arg));
    if (script) return path.resolve(script);
  } catch {
    // macOS has no /proc; use lsof/ps below.
  }
  try {
    const output = execute('ps', ['-p', String(pid), '-o', 'command=']).trim();
    const expectedScript = ['js', 'mjs', 'cjs', 'ts']
      .map((extension) => path.join(expectedRoot, 'dist', `index.${extension}`))
      .find((candidate) =>
        new RegExp(`(?:^|\\s)${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(output),
      );
    if (expectedScript) return expectedScript;
    const marker = output.indexOf('/dist/index.');
    if (marker > 0) {
      const start = output.lastIndexOf(' ', marker) + 1;
      const script = output.slice(start, marker + output.slice(marker).search(/(?:\s|$)/));
      if (/\/dist\/index\.(?:js|mjs|cjs|ts)$/.test(script)) return path.resolve(script);
    }
  } catch {
    // Identity is intentionally fail-closed.
  }
  try {
    const output = execute('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
    const script = output
      .split('\n')
      .find((line) => line.startsWith('n') && /\/dist\/index\.(?:js|mjs|cjs|ts)$/.test(line.slice(1)))
      ?.slice(1)
      .trim();
    if (script) return path.resolve(script);
  } catch {
    // Identity is intentionally fail-closed.
  }
  return null;
}

function isResource(value: unknown): value is HealthResource {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.state === 'loaded' || record.state === 'empty') &&
    typeof record.count === 'number' &&
    Number.isInteger(record.count) &&
    record.count >= 0
  );
}

function isHostHealth(value: unknown): value is HostHealth {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const processIdentity = record.process;
  const resources = record.resources;
  if (
    record.status !== 'healthy' ||
    typeof record.checkoutRoot !== 'string' ||
    !processIdentity ||
    typeof processIdentity !== 'object' ||
    !resources ||
    typeof resources !== 'object'
  )
    return false;
  const processRecord = processIdentity as Record<string, unknown>;
  const resourceRecord = resources as Record<string, unknown>;
  return (
    typeof processRecord.pid === 'number' &&
    processRecord.pid > 0 &&
    typeof processRecord.ppid === 'number' &&
    typeof processRecord.executable === 'string' &&
    typeof processRecord.script === 'string' &&
    typeof processRecord.cwd === 'string' &&
    isResource(resourceRecord.groups) &&
    isResource(resourceRecord.policies) &&
    isResource(resourceRecord.skills)
  );
}
