/**
 * Reload the running host after setup changed code it loads.
 *
 * The service runs the compiled `dist/` and reads `.env` only at start, so a
 * payload that adds host code stays invisible until the host is rebuilt and
 * restarted. `restart.sh` restarts whichever service this install uses
 * (launchd, systemd or the nohup wrapper) and waits for the new instance.
 *
 * The result is returned, never printed: the caller decides how loud a
 * failure is.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** What an operator runs by hand when the automatic reload fails. */
export const HOST_RESTART_COMMAND = 'pnpm run build && bash setup/lib/restart.sh';

/** `no-service`: nothing runs this checkout's host, so there is nothing to reload. */
export type HostRestartResult =
  | { status: 'restarted' }
  | { status: 'no-service' }
  | { status: 'failed'; message: string };

/** The `.env` text the host reads at start; compare two reads to see whether a restart is due. */
export function readHostSettings(projectRoot: string = process.cwd()): string {
  try {
    return fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  } catch {
    return '';
  }
}

/** Rebuild the host and restart its service. Synchronous with inherited output. */
export function restartHost(projectRoot: string = process.cwd()): HostRestartResult {
  const steps: Array<[string, string[]]> = [
    ['pnpm', ['run', 'build']],
    ['bash', ['setup/lib/restart.sh']],
  ];
  for (const [command, args] of steps) {
    const res = spawnSync(command, args, { cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit'] });
    const step = `${command} ${args.join(' ')}`;
    if (res.error) return { status: 'failed', message: `couldn't run ${step}: ${res.error.message}` };
    if (res.signal) return { status: 'failed', message: `${step} was terminated by ${res.signal}` };
    if (command === 'bash' && res.status === 2) return { status: 'no-service' };
    if (res.status !== 0) return { status: 'failed', message: `${step} exited ${res.status}` };
  }
  return { status: 'restarted' };
}
