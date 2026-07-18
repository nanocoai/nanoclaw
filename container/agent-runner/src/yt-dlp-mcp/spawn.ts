import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface YtDlpResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 1200;

export async function runYtDlp(
  args: string[],
  opts: { timeoutSec?: number } = {},
): Promise<YtDlpResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const proc = Bun.spawn(['yt-dlp', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, timeoutSec * 1000);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { stdout, stderr, code, timedOut };
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function okJson(payload: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}

export function fail(error: string): CallToolResult {
  console.error(`[yt-dlp-mcp] ${error}`);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
    isError: true,
  };
}

export function tailStderr(s: string, max = 500): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return '...' + trimmed.slice(-max);
}
