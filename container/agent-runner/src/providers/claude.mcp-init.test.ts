import { describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const message of sdkMessages) yield message;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

describe('Claude SDK MCP init status', () => {
  it('writes unavailable MCP servers to stderr without aborting init', async () => {
    sdkMessages.length = 0;
    sdkMessages.push({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-mcp',
      mcp_servers: [
        { name: 'healthy', status: 'connected' },
        { name: 'missing-runtime', status: 'failed' },
        { name: 'intentionally-off', status: 'disabled' },
      ],
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-init-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tmp;
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const provider = new ClaudeProvider({});
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'hi', cwd: tmp });
      const events = [];
      for await (const event of query.events) events.push(event);

      expect(events.some((event) => event.type === 'init' && event.continuation === 'sess-mcp')).toBe(true);
      expect(logs).toContain(
        '[claude-provider] ERROR: MCP server "missing-runtime" is unavailable ' +
          '(status: failed); its tools will not be available',
      );
      expect(logs.some((line) => line.includes('healthy'))).toBe(false);
      expect(logs.some((line) => line.includes('intentionally-off'))).toBe(false);
    } finally {
      console.error = originalConsoleError;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
