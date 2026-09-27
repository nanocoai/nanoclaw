import { spawn } from 'node:child_process';

interface InstallCommandOptions {
  label: string;
  timeoutMs: number;
  cwd?: string;
  capture?: boolean;
  failureHint?: string;
  /** Reported instead of the failure message when a non-zero exit is an expected outcome (a cache probe). */
  absentHint?: string;
  /** Test seams; production uses bounded ten-second progress updates. */
  heartbeatMs?: number;
  killGraceMs?: number;
  report?: (line: string) => void;
}

export class InstallCommandFailure extends Error {
  constructor(
    message: string,
    readonly interrupted = false,
  ) {
    super(message);
  }
}

/** Show trusted stage descriptions, never child output: Git credential helpers,
 * Docker and Rails can include credentials in failures. Git cannot prompt. Each
 * command has a deadline and its process group is killed before cleanup proceeds. */
export function installCommand(command: string, args: string[], options: InstallCommandOptions): Promise<string> {
  const report = options.report ?? console.log;
  const start = Date.now();
  const elapsed = () => `${Math.floor((Date.now() - start) / 1000)}s`;
  report(`${options.label}…`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let reason = '';
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = (message: string) => {
      if (reason) return;
      reason = message;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), options.killGraceMs ?? 1000);
    };
    const interrupted = () => stop('cancelled');
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const heartbeat = setInterval(
      () => report(`${options.label}: still running (${elapsed()}, limit ${Math.ceil(options.timeoutMs / 1000)}s)`),
      options.heartbeatMs ?? 10_000,
    );
    const deadline = setTimeout(
      () => stop(`timed out after ${Math.ceil(options.timeoutMs / 1000)}s`),
      options.timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (!options.capture) return;
      output += chunk.toString('utf8');
      if (output.length > 1024 * 1024) stop('returned too much output');
    });
    child.stderr.on('data', () => {
      /* Drain without exposing potentially secret diagnostics. */
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      // A helper may survive its parent and close its streams early.
      if (reason) killGroup('SIGKILL');
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      if (code === 0 && !reason) {
        report(`${options.label}: done (${elapsed()})`);
        resolve(output.trim());
      } else {
        const message =
          !reason && options.absentHint
            ? `${options.label}: ${options.absentHint}`
            : `${options.label} ${reason || `failed (exit ${code ?? 'unknown'})`}. ${options.failureHint ?? 'Check the service and retry this step.'}`;
        report(message);
        reject(new InstallCommandFailure(message, Boolean(reason)));
      }
    };
    child.once('error', () => {
      reason ||= 'could not start';
      finish(null);
    });
    child.once('close', finish);
  });
}

/** Existing skill-engine streaming protocol: failed installs never report success. */
export async function installStep(
  action: () => Promise<void>,
  report: (line: string) => void = console.log,
): Promise<boolean> {
  try {
    await action();
    report('=== NANOCLAW SETUP: IRON_GATEWAY ===\nSTATUS: success\n=== END ===');
    return true;
  } catch (error) {
    // Callers must provide curated errors; no child stderr reaches this boundary.
    report(error instanceof Error ? error.message : 'Iron installation failed');
    report('=== NANOCLAW SETUP: IRON_GATEWAY ===\nSTATUS: failed\n=== END ===');
    return false;
  }
}
