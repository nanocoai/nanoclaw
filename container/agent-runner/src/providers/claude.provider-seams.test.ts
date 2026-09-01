import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

let capturedOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    capturedOptions = options;
    return (async function* () {})();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-disallowed-tools-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  capturedOptions = undefined;
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider disallowed tools', () => {
  it('enforces the SDK disallow list in SDK options, allowlist, and the safety hook', async () => {
    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: tmp });

    expect(capturedOptions?.disallowedTools).toEqual(expect.arrayContaining(['SendMessage', 'AskUserQuestion']));
    expect(capturedOptions?.allowedTools).not.toContain('SendMessage');
    expect(capturedOptions?.allowedTools).toContain('Bash');

    const hooks = capturedOptions?.hooks as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>;
    };
    expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'SendMessage', tool_input: {} })).toMatchObject({
      decision: 'block',
    });
  });

  it('lets a provider remove additional built-ins from the SDK and safety hook', async () => {
    const provider = new ClaudeProvider({ disallowedTools: ['WebSearch', 'WebFetch'] });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'stay offline', cwd: tmp });

    expect(capturedOptions?.disallowedTools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    expect(capturedOptions?.allowedTools).not.toContain('WebSearch');
    expect(capturedOptions?.allowedTools).not.toContain('WebFetch');

    const hooks = capturedOptions?.hooks as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>;
    };
    expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'WebFetch', tool_input: {} })).toMatchObject({
      decision: 'block',
    });
  });

  it('lets a provider stop after an asynchronous tool handoff', async () => {
    class HandoffProvider extends ClaudeProvider {
      protected override shouldStopAfterTool(toolName: string, toolInput: Record<string, unknown>): boolean {
        return toolName === 'mcp__nanoclaw__create_agent' && toolInput.to === 'worker';
      }
    }

    const provider = new HandoffProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: tmp });

    const hooks = capturedOptions?.hooks as {
      PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>;
    };
    expect(
      await hooks.PostToolUse[0]!.hooks[0]!({
        tool_name: 'mcp__nanoclaw__create_agent',
        tool_input: { to: 'worker' },
      }),
    ).toMatchObject({ continue: false });
    expect(await hooks.PostToolUse[0]!.hooks[0]!({ tool_name: 'Bash' })).toEqual({ continue: true });
  });
});

describe('ClaudeProvider SDK settings passthrough', () => {
  it('forwards provider settings into the SDK flag-settings layer', () => {
    const provider = new ClaudeProvider({ settings: { skipWebFetchPreflight: true } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: tmp });

    expect(capturedOptions?.settings).toEqual({ skipWebFetchPreflight: true });
  });

  it('sends no settings overlay when a provider asks for none', () => {
    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: tmp });

    expect(capturedOptions?.settings).toBeUndefined();
  });
});

describe('ClaudeProvider tool aliases', () => {
  it('forwards provider-owned tool redirects to the SDK', () => {
    const provider = new ClaudeProvider({ toolAliases: { WebFetch: 'mcp__nanoclaw__ollama_web_fetch' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'fetch locally', cwd: tmp });

    expect(capturedOptions?.toolAliases).toEqual({ WebFetch: 'mcp__nanoclaw__ollama_web_fetch' });
  });

  it('sends no aliases when a provider asks for none', () => {
    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'hi', cwd: tmp });

    expect(capturedOptions?.toolAliases).toBeUndefined();
  });
});
