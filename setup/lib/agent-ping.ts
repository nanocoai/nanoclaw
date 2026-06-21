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

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error';

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

/**
 * Retry a ping while the host is still booting.
 *
 * The `service` step reports success the moment `launchctl load` / `systemctl
 * start` returns — before the host process has bound its CLI socket. A ping
 * fired immediately after therefore often hits a missing socket and comes back
 * `socket_error`, even though the host is up a moment later. Retry on that one
 * result for a bounded window before giving up; any other result (ok, auth,
 * no_reply) is conclusive and returns immediately.
 *
 * `now` and `sleep` are injectable so the retry loop can be unit-tested
 * without real timers.
 */
export async function waitForPing(
  ping: () => Promise<PingResult>,
  {
    windowMs = 10_000,
    intervalMs = 1_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    windowMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PingResult> {
  const deadline = now() + windowMs;
  let result = await ping();
  while (result === 'socket_error' && now() < deadline) {
    await sleep(intervalMs);
    result = await ping();
  }
  return result;
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve('no_reply');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(classifyPingResult(code, stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('socket_error');
    });
  });
}
