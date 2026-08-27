import { describe, expect, it } from 'bun:test';

import { type AppServer, codexRuntimeOwnership, type writeCodexConfigToml } from './codex-app-server.js';
import { CodexProvider, type CodexRuntimeDeps } from './codex.js';

const MEMORY_HOOK = { command: 'bun /app/src/memory/hook.ts', legacyCommands: [], sources: ['startup'] };

/**
 * Runtime deps that record config writes and stop the query at the app-server
 * handshake, so no codex binary is ever spawned.
 */
function recordingRuntime(): { runtime: CodexRuntimeDeps; writes: Parameters<typeof writeCodexConfigToml>[] } {
  const writes: Parameters<typeof writeCodexConfigToml>[] = [];
  const runtime: CodexRuntimeDeps = {
    writeCodexConfigToml: (...args) => {
      writes.push(args);
    },
    spawnCodexAppServer: () =>
      ({
        process: { stdin: { write: () => true } },
        readline: { close: () => {} },
        pending: new Map(),
        notificationHandlers: [],
        exitHandlers: [],
        serverRequestHandlers: [],
      }) as unknown as AppServer,
    attachCodexAutoApproval: () => {},
    initializeCodexAppServer: async () => {
      throw new Error('handshake stopped by test');
    },
    startOrResumeCodexThread: async () => 'thread-unreached',
    startCodexTurn: async () => 'turn-unreached',
    steerCodexTurn: async () => {},
    interruptCodexTurn: async () => {},
    killCodexAppServer: () => {},
  };
  return { runtime, writes };
}

async function runQueryToHandshake(provider: CodexProvider): Promise<void> {
  provider.registerMemorySessionHook(MEMORY_HOOK);
  const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
  await expect(query.events.next()).rejects.toThrow('handshake stopped by test');
}

describe('CodexProvider', () => {
  it('rejects unsupported reasoning effort values', () => {
    expect(() => new CodexProvider({ effort: 'max' })).toThrow(/Unsupported Codex reasoning effort/);
  });

  it('normalizes supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'HIGH' })).toBeInstanceOf(CodexProvider);
  });

  it('accepts supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'xhigh' })).toBeInstanceOf(CodexProvider);
  });

  it('requires the shared memory hook before starting a query', () => {
    expect(() => new CodexProvider({}).query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/not registered/);
  });

  it('writes the runtime files exactly once per query when no contract owns them', async () => {
    const previous = codexRuntimeOwnership.contractOwnsRuntimeFiles;
    codexRuntimeOwnership.contractOwnsRuntimeFiles = false;
    try {
      const { runtime, writes } = recordingRuntime();
      const servers = { nanoclaw: { command: 'bun' } };
      await runQueryToHandshake(
        new CodexProvider({ mcpServers: servers, model: 'gpt-5', effort: 'HIGH', speed: 'fast' }, runtime),
      );
      expect(writes).toHaveLength(1);
      const [mcpServers, hook, inference] = writes[0];
      expect(mcpServers).toEqual(servers);
      expect(hook).toEqual(MEMORY_HOOK);
      // The same normalized values the contract path renders from.
      expect(inference).toEqual({ model: 'gpt-5', effort: 'high', fastMode: true });
    } finally {
      codexRuntimeOwnership.contractOwnsRuntimeFiles = previous;
    }
  });

  it('leaves the runtime files to the contract when its module owns them', async () => {
    const previous = codexRuntimeOwnership.contractOwnsRuntimeFiles;
    codexRuntimeOwnership.contractOwnsRuntimeFiles = true;
    try {
      const { runtime, writes } = recordingRuntime();
      await runQueryToHandshake(new CodexProvider({ model: 'gpt-5' }, runtime));
      expect(writes).toHaveLength(0);
    } finally {
      codexRuntimeOwnership.contractOwnsRuntimeFiles = previous;
    }
  });

  it('consumes core-resolved configuration instead of re-deriving it', async () => {
    const previous = codexRuntimeOwnership.contractOwnsRuntimeFiles;
    codexRuntimeOwnership.contractOwnsRuntimeFiles = false;
    try {
      const { runtime, writes } = recordingRuntime();
      const resolvedServers = { resolved: { command: 'resolved-bin' } };
      const provider = new CodexProvider({ mcpServers: { ignored: { command: 'x' } }, model: 'ignored' }, runtime, {
        executionPolicy: {},
        inference: { model: 'gpt-5', effort: 'high', fastMode: undefined },
        mcpServers: resolvedServers,
      });
      await runQueryToHandshake(provider);
      const [mcpServers, , inference] = writes[0];
      expect(mcpServers).toEqual(resolvedServers);
      expect(inference).toEqual({ model: 'gpt-5', effort: 'high', fastMode: undefined });
    } finally {
      codexRuntimeOwnership.contractOwnsRuntimeFiles = previous;
    }
  });
});
