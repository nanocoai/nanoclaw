import { spawn } from 'node:child_process';

import { redactSensitiveValues } from './redaction.js';
import { childEnvWithoutSetupSecrets } from './secret-file.js';
import type { SetupDriver } from './setup-driver.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MACHINE_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

export type InteractiveProcessResult =
  | { reason: 'exited'; exitCode: number }
  | { reason: 'spawn_failed'; message: string }
  | { reason: 'output_limit' }
  | { reason: 'timed_out' };

export type InteractiveProcessInput = {
  write(value: string): void;
  end(): void;
};

type InteractiveProcessOptions = {
  env?: Record<string, string | undefined>;
  /** Machine-mode deadline. Terminal mode remains operator-controlled. */
  timeoutMs?: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr', input: InteractiveProcessInput) => void | Promise<void>;
};

export function machineChildEnvironment(
  overrides: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const key of MACHINE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return childEnvWithoutSetupSecrets({ ...env, ...overrides });
}

/**
 * Run one provider-owned interactive CLI.
 *
 * Terminal mode preserves inherited stdio. Machine mode exposes bounded raw
 * chunks only to the provider callback, which owns interpretation and
 * redaction, while this helper owns child lifetime and process-group cleanup.
 */
export function runInteractiveProcess(
  driver: SetupDriver,
  command: string,
  args: string[],
  options: InteractiveProcessOptions = {},
): Promise<InteractiveProcessResult> {
  driver.throwIfCancelled();
  const machine = driver.mode === 'ndjson';

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: machine ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      env: machine
        ? machineChildEnvironment(options.env)
        : options.env
          ? { ...process.env, ...options.env }
          : process.env,
      ...(machine ? { detached: true } : {}),
    });

    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let spawnFailure: string | undefined;
    let callbackFailure: unknown;
    let callbackChain = Promise.resolve();
    let finished = false;

    const stopGroup = (): void => {
      if (!machine || !child.pid) return;
      const processGroupId = child.pid;
      try {
        process.kill(-processGroupId, 'SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-processGroupId, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 250);
    };

    const onParentExit = (): void => {
      if (!machine || !child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    if (machine) process.once('exit', onParentExit);
    const timeout =
      machine && options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            stopGroup();
          }, options.timeoutMs).unref()
        : undefined;

    const input: InteractiveProcessInput = {
      write(value) {
        if (machine && child.stdin?.writable) child.stdin.write(value);
      },
      end() {
        if (machine && child.stdin?.writable) child.stdin.end();
      },
    };

    const forward = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (outputLimitExceeded || callbackFailure !== undefined) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        stopGroup();
        return;
      }
      if (!options.onOutput) return;
      const text = chunk.toString('utf8');
      callbackChain = callbackChain
        .then(() => options.onOutput?.(text, stream, input))
        .catch((error: unknown) => {
          callbackFailure = error;
          stopGroup();
        });
    };

    if (machine) {
      child.stdout?.on('data', (chunk: Buffer) => forward(chunk, 'stdout'));
      child.stderr?.on('data', (chunk: Buffer) => forward(chunk, 'stderr'));
    }

    const onCancel = (): void => stopGroup();
    driver.cancellationSignal?.addEventListener('abort', onCancel, { once: true });
    if (driver.cancellationSignal?.aborted) stopGroup();

    const finish = async (code: number | null): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (machine) process.removeListener('exit', onParentExit);
      driver.cancellationSignal?.removeEventListener('abort', onCancel);
      await callbackChain;
      if (callbackFailure !== undefined) {
        reject(callbackFailure);
        return;
      }
      try {
        driver.throwIfCancelled();
      } catch (error) {
        reject(error);
        return;
      }
      if (timedOut) {
        resolve({ reason: 'timed_out' });
      } else if (outputLimitExceeded) {
        resolve({ reason: 'output_limit' });
      } else if (spawnFailure !== undefined) {
        resolve({ reason: 'spawn_failed', message: spawnFailure });
      } else {
        resolve({ reason: 'exited', exitCode: code ?? 1 });
      }
    };

    child.on('error', (error) => {
      spawnFailure = redactSensitiveValues(error.message);
    });
    child.on('close', (code) => {
      void finish(code);
    });
  });
}
