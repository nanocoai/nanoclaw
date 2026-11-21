/**
 * The out-of-process steps of a self-edit: the agent-runner typecheck gate,
 * and the hand-off to the watchdog for anything that needs a host restart.
 */
import { execFile, spawn, spawnSync } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

export type CheckResult = { ok: true } | { ok: false; output: string };

/** Typecheck the agent-runner tree — the gate for edits under container/. */
export async function runContainerCheck(root: string): Promise<CheckResult> {
  try {
    await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'container/agent-runner/tsconfig.json', '--noEmit'], {
      cwd: root,
      timeout: CHECK_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return { ok: true };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed typecheck is a verdict, reported to the agent
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') };
  }
}

/**
 * Start scripts/repo-self-edit-watchdog.sh outside the host's lifetime. The
 * watchdog restarts the service this process runs in, so it must not be a
 * child the service manager kills along with the host: on systemd it runs
 * as its own transient unit, elsewhere as a detached session leader.
 */
export function spawnWatchdog(root: string, newSha: string, sessionId: string): void {
  const script = path.join(root, 'scripts', 'repo-self-edit-watchdog.sh');
  const args = [script, newSha, sessionId];

  const systemdRun =
    process.platform === 'linux' && spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status === 0;
  const [cmd, cmdArgs] = systemdRun
    ? ['systemd-run', ['--user', '--collect', '--quiet', `--working-directory=${root}`, 'bash', ...args]]
    : ['bash', args];

  // The script appends its own output to logs/repo-self-edit-watchdog.log.
  const child = spawn(cmd, cmdArgs, { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
}
