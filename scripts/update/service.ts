import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getInstallSlug } from '../../src/install-slug.js';

export interface CommandRunner {
  run(command: string, args: string[], cwd?: string): string;
  tryRun(command: string, args: string[], cwd?: string): { ok: boolean; stdout: string };
}

export function createCommandRunner(): CommandRunner {
  const run = (command: string, args: string[], cwd?: string): string =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  return {
    run,
    tryRun(command, args, cwd) {
      try {
        return { ok: true, stdout: run(command, args, cwd) };
      } catch (err) {
        const failed = err as { stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          ok: false,
          stdout: [failed.stdout, failed.stderr]
            .map((part) => part?.toString().trim())
            .filter(Boolean)
            .join('\n'),
        };
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
}

export function defaultServiceEnvironment(runner = createCommandRunner()): ServiceEnvironment {
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    runner,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(definition) && fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      return {
        mode: 'nohup',
        definition,
        pid: Number.isFinite(pid) ? pid : undefined,
        active: Number.isFinite(pid) && processExists(pid),
      };
    }
  }

  const unmanaged = env.runner.tryRun('pgrep', ['-f', `${escapeRegex(projectRoot)}/(dist/index\\.js|src/index\\.ts)`]);
  if (unmanaged.ok && unmanaged.stdout) {
    return { mode: 'unmanaged', active: true, name: unmanaged.stdout.split('\n').join(',') };
  }
  return { mode: 'none', active: false };
}

export async function stopService(handle: ServiceHandle, env: ServiceEnvironment): Promise<void> {
  if (!handle.active) return;
  if (handle.mode === 'launchd') {
    env.runner.run('launchctl', ['bootout', `gui/${env.uid}/${handle.name}`]);
  } else if (handle.mode === 'systemd-user') {
    env.runner.run('systemctl', ['--user', 'stop', handle.name!]);
  } else if (handle.mode === 'systemd-system') {
    env.runner.run('systemctl', ['stop', handle.name!]);
  } else if (handle.mode === 'nohup' && handle.pid) {
    process.kill(handle.pid, 'SIGTERM');
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

export async function drainContainers(
  projectRoot: string,
  env: ServiceEnvironment,
  timeoutMs = 300_000,
): Promise<void> {
  const runtime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const label = `nanoclaw-install=${getInstallSlug(projectRoot)}`;
  const started = Date.now();
  while (true) {
    const listed = env.runner.tryRun(runtime, ['ps', '-q', '--filter', `label=${label}`]);
    if (!listed.ok) throw new Error(`Cannot inspect active NanoClaw containers with ${runtime}`);
    if (!listed.stdout) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for active NanoClaw containers: ${listed.stdout.split('\n').join(', ')}`);
    }
    await env.sleep(1_000);
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
