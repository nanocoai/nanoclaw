// The service runs the dist/ it loaded at start; rebuild and restart it after setup adds host code. Returns, never prints.
import { spawnSync } from 'child_process';

/** What an operator runs by hand when the automatic reload fails. */
export const HOST_RESTART_COMMAND = 'pnpm run build && bash setup/lib/restart.sh';

/** `no-service`: nothing runs this checkout's host, so there is nothing to reload. */
export type HostRestartResult =
  | { status: 'restarted' }
  | { status: 'no-service' }
  | { status: 'failed'; message: string };

/** Rebuild the host and restart its service. */
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
