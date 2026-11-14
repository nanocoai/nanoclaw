// The service runs the dist/ it loaded at start; rebuild and restart it after setup adds host code.
import { spawnSync } from 'child_process';

/** What an operator runs by hand when the automatic reload fails. */
export const HOST_RESTART_COMMAND = 'pnpm run build && bash setup/lib/restart.sh';

/** `no-service`: nothing runs this checkout's host, so there is nothing to reload. */
export type HostRestartResult =
  | { status: 'restarted' }
  | { status: 'no-service' }
  | { status: 'failed'; step: 'build' | 'restart'; message: string };

/** Rebuild the host and restart its service. Prints only what the build and restart.sh print. */
export function restartHost(projectRoot: string = process.cwd()): HostRestartResult {
  // A build with type errors must not leave new JS in dist/ for the next restart to load.
  const steps: Array<['build' | 'restart', string, string[]]> = [
    ['build', 'pnpm', ['run', 'build', '--noEmitOnError']],
    ['restart', 'bash', ['setup/lib/restart.sh']],
  ];
  for (const [name, command, args] of steps) {
    // restart.sh's stderr is held back: on no-service the caller says it, so its own line would repeat.
    const stderr = name === 'restart' ? 'pipe' : 'inherit';
    const res = spawnSync(command, args, { cwd: projectRoot, stdio: ['ignore', 'inherit', stderr], encoding: 'utf8' });
    const step = `${command} ${args.join(' ')}`;
    if (name === 'restart' && res.status === 2) return { status: 'no-service' };
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.error) return { status: 'failed', step: name, message: `couldn't run ${step}: ${res.error.message}` };
    if (res.signal) return { status: 'failed', step: name, message: `${step} was terminated by ${res.signal}` };
    if (res.status !== 0) return { status: 'failed', step: name, message: `${step} exited ${res.status}` };
  }
  return { status: 'restarted' };
}
