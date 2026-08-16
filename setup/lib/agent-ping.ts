/**
 * Round-trip check against the CLI Unix socket.
 *
 * Shared by `setup/verify.ts` (end-of-run health check) and `setup/auto.ts`
 * (confirm the freshly-wired agent actually responds before prompting the
 * user to chat with it).
 *
 * Exit-code contract follows `scripts/chat.ts`:
 *   0  → got a reply on stdout
 *   2  → socket unreachable (service not running or wrong checkout)
 *   3  → no reply before chat.ts's own 120s hard stop
 * This wrapper also guards with its own timeout in case chat.ts hangs.
 */
import { spawn } from 'child_process';

import { childEnvWithoutSetupSecrets } from './secret-file.js';
import type { SetupDriver } from './setup-driver.js';

export const PING_AGENT_FOLDER = 'ping_test';

const MAX_MACHINE_PING_OUTPUT_BYTES = 64 * 1024;

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error' | 'output_limit';

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (
    /Invalid bearer token/i.test(output) ||
    /authentication[_ ]error/i.test(output) ||
    /Failed to authenticate/i.test(output) ||
    /Please run \/login/i.test(output) ||
    /Not logged in/i.test(output) ||
    /Invalid API key/i.test(output)
  ) {
    return 'auth_error';
  }
  if (exitCode === 2) return 'socket_error';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

export function pingCliAgent(timeoutMs = 30_000, driver?: SetupDriver): Promise<PingResult> {
  return new Promise((resolve) => {
    const machine = driver?.mode === 'ndjson';
    const child = spawn('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(machine ? { detached: true, env: childEnvWithoutSetupSecrets() } : {}),
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const stopGroup = (): void => {
      if (!child.pid) return;
      if (!machine) {
        child.kill('SIGKILL');
        return;
      }
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
    const onAbort = (): void => {
      stopGroup();
      settle('no_reply');
    };
    const settle = (result: PingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      driver?.cancellationSignal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stopGroup();
      settle('no_reply');
    }, timeoutMs);
    driver?.cancellationSignal?.addEventListener('abort', onAbort, { once: true });
    if (driver?.cancellationSignal?.aborted) onAbort();

    const append = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      if (machine) {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_MACHINE_PING_OUTPUT_BYTES) {
          stopGroup();
          settle('output_limit');
          return;
        }
      }
      if (stream === 'stdout') stdout += chunk.toString('utf-8');
      else stderr += chunk.toString('utf-8');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      append(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      append(chunk, 'stderr');
    });
    child.on('close', (code) => {
      settle(classifyPingResult(code, stdout, stderr));
    });
    child.on('error', () => {
      settle('socket_error');
    });
  });
}
