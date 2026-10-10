/**
 * The one process-spawning seam both drivers sit on.
 *
 * Drivers take a `Cli` rather than importing child_process directly, which is
 * what lets the conformance suite drive a real spec through real realization
 * logic against a fake runtime.
 */
import { execFileSync, spawn } from 'child_process';

export interface SupervisedProcess {
  /** Fires once with the exit code (or null when killed by signal). */
  onExit(cb: (code: number | null) => void): void;
  /** Every stderr line, already split. */
  onStderr(cb: (line: string) => void): void;
  /** Every stdout line, already split. */
  onStdout(cb: (line: string) => void): void;
  kill(): void;
}

export interface Cli {
  readonly bin: string;
  /** Run to completion. Throws on a non-zero exit. */
  run(args: string[], opts?: { input?: string; timeoutMs?: number }): string;
  /** Start and supervise. */
  start(args: string[], opts?: { captureStdout?: boolean }): SupervisedProcess;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function realCli(bin: string): Cli {
  return {
    bin,
    run(args, opts) {
      return execFileSync(bin, args, {
        stdio: 'pipe',
        input: opts?.input,
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      }).toString();
    },
    start(args, opts) {
      const child = spawn(bin, args, {
        stdio: ['ignore', opts?.captureStdout ? 'pipe' : 'ignore', 'pipe'],
        // Own process group. A service manager restarting the host signals the
        // host's WHOLE group, and `docker start --attach` forwards signals into
        // the container — undetached, every host restart would ride through
        // the attach helpers into every `--rm` container, erasing the sessions
        // adoption exists to preserve. Detached, the helpers sit outside the
        // signaled group: kill() still reaches them directly, and one orphaned
        // by host death lingers only until its container exits.
        detached: true,
      });
      const exitCbs: Array<(code: number | null) => void> = [];
      const stderrCbs: Array<(line: string) => void> = [];
      const stdoutCbs: Array<(line: string) => void> = [];
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        for (const cb of exitCbs) cb(code);
      };
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) for (const cb of stderrCbs) cb(line);
        }
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const cb of stdoutCbs) cb(chunk.toString());
      });
      child.on('close', (code) => settle(code));
      child.on('error', () => settle(null));
      return {
        onExit: (cb) => exitCbs.push(cb),
        onStderr: (cb) => stderrCbs.push(cb),
        onStdout: (cb) => stdoutCbs.push(cb),
        kill: () => child.kill('SIGKILL'),
      };
    },
  };
}

/** Runtime object names are interpolated into argv; keep them boring. */
export function validateRuntimeName(name: string, kind: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid ${kind} name: ${name}`);
  }
  return name;
}
