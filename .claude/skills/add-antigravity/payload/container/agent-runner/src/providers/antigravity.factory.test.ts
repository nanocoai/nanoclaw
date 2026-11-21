import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  type AntigravityMcpConfig,
  antigravityMcpConfigPath,
  antigravityMcpServersSection,
  antigravityRuntimeOwnership,
  antigravitySettingsPath,
  writeAntigravityRuntimeFiles,
} from './antigravity-config.js';
import { AntigravityProvider, type AntigravityRuntimeDeps, defaultAntigravityRuntimeDeps } from './antigravity.js';
import type { McpServerConfig } from './types.js';

// The contract-core tests need the runtime-contract core (registry + realize +
// factory wiring). On a pre-contract install it is absent, so they skip there.
const hasContractCore = fs.existsSync(new URL('../provider-contracts/realize.ts', import.meta.url));

const MEMORY_HOOK = { command: 'bun /app/src/memory/hook.ts', legacyCommands: [], sources: ['startup'] };

const SERVERS: Record<string, McpServerConfig> = {
  nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Version': '2024-06' } },
};

/**
 * Runtime deps that record what the provider would write and spawn, then stop
 * the query at the spawn, so no agy binary is ever started.
 */
function recordingRuntime() {
  const writes: AntigravityMcpConfig[] = [];
  const rules: unknown[] = [];
  const spawns: string[][] = [];
  const runtime: AntigravityRuntimeDeps = {
    writeRuntimeFiles: (config) => {
      writes.push(config);
    },
    prepareRules: async (hook) => {
      rules.push(hook);
    },
    spawnAgy: (args) => {
      spawns.push(args);
      throw new Error('spawn stopped by test');
    },
    killGraceMs: 10,
  };
  return { runtime, writes, rules, spawns };
}

async function runQueryToSpawn(provider: AntigravityProvider, continuation?: string): Promise<void> {
  const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent', continuation });
  await expect(query.events.next()).rejects.toThrow('spawn stopped by test');
}

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-factory-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('AntigravityProvider construction', () => {
  // These tests drive the provider's own write path explicitly. The flag is
  // restored here only: the contract-path tests below rely on the contract
  // module having set it when it loaded.
  let previousOwnership: boolean;
  beforeEach(() => {
    previousOwnership = antigravityRuntimeOwnership.contractOwnsRuntimeFiles;
  });
  afterEach(() => {
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = previousOwnership;
  });

  it('starts without --effort when the group carries an effort agy does not accept', async () => {
    const { runtime, spawns } = recordingRuntime();
    const provider = new AntigravityProvider({ model: 'gemini-3.8-flash-medium', effort: 'minimal' }, runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    await runQueryToSpawn(provider);
    expect(spawns[0].slice(5)).toEqual(['--model', 'gemini-3.8-flash-medium']);
  });

  it('requires the shared memory hook before starting a query', () => {
    expect(() => new AntigravityProvider({}).query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(
      /not registered/,
    );
  });

  it('writes the runtime files exactly once per query when no contract owns them', async () => {
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
    const { runtime, writes, rules, spawns } = recordingRuntime();
    const provider = new AntigravityProvider(
      { mcpServers: SERVERS, model: 'gemini-3.8-flash-medium', effort: 'HIGH', speed: 'fast' },
      runtime,
    );
    provider.registerMemorySessionHook(MEMORY_HOOK);
    await runQueryToSpawn(provider);

    expect(writes).toEqual([antigravityMcpServersSection(SERVERS)]);
    expect(rules).toEqual([MEMORY_HOOK]);
    expect(spawns[0].slice(5)).toEqual(['--model', 'gemini-3.8-flash-medium', '--effort', 'high']);
  });

  it('leaves the runtime files to the contract when its module owns them', async () => {
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = true;
    const { runtime, writes, rules } = recordingRuntime();
    const provider = new AntigravityProvider({}, runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    await runQueryToSpawn(provider);
    expect(writes).toHaveLength(0);
    // The rule file is always the provider's: it needs the query's input.
    expect(rules).toHaveLength(1);
  });

  it('consumes core-resolved configuration instead of re-deriving it', async () => {
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
    const { runtime, writes, spawns } = recordingRuntime();
    const resolvedMcp = { mcpServers: { resolved: { command: 'resolved-bin' } } };
    const provider = new AntigravityProvider({ mcpServers: SERVERS, model: 'ignored' }, runtime, {
      executionPolicy: { permissionMode: 'always-proceed', args: ['--resolved-policy'] },
      inference: { args: ['--model', 'resolved-model'] },
      mcpServers: resolvedMcp,
    });
    provider.registerMemorySessionHook(MEMORY_HOOK);
    await runQueryToSpawn(provider, 'conv-1');
    expect(writes).toEqual([resolvedMcp]);
    expect(spawns[0]).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--resolved-policy',
      '--model',
      'resolved-model',
      '--conversation',
      'conv-1',
    ]);
  });

  it('runs the resolved memory section when core passes one', async () => {
    const { runtime, rules } = recordingRuntime();
    const provider = new AntigravityProvider({}, runtime);
    const resolved = { command: 'resolved-hook', legacyCommands: [], sources: ['startup'] };
    provider.registerMemorySessionHook(MEMORY_HOOK, resolved);
    await runQueryToSpawn(provider);
    expect(rules[0]).toEqual(resolved);
  });
});

function readFiles(dir: string): { settings: string; mcp: string } {
  const env = { HOME: dir };
  return {
    settings: fs.readFileSync(antigravitySettingsPath(env), 'utf-8'),
    mcp: fs.readFileSync(antigravityMcpConfigPath(env), 'utf-8'),
  };
}

(hasContractCore ? describe : describe.skip)('antigravity contract path', () => {
  it('produces byte-identical files through the contract path and the legacy writer', async () => {
    await import('./index.js');
    await import('../provider-contracts/index.js');
    const { runProviderBeforeQuery } = await import('../provider-contracts/realize.js');

    const legacyHome = path.join(home, 'legacy');
    const contractHome = path.join(home, 'contract');
    for (const dir of [legacyHome, contractHome]) {
      fs.mkdirSync(path.join(dir, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gemini', 'antigravity-cli', 'settings.json'), '{"keep":true}');
    }

    process.env.HOME = legacyHome;
    writeAntigravityRuntimeFiles(antigravityMcpServersSection(SERVERS));

    process.env.HOME = contractHome;
    runProviderBeforeQuery('antigravity', { inference: {}, memory: MEMORY_HOOK, mcpServers: SERVERS });

    expect(readFiles(contractHome)).toEqual(readFiles(legacyHome));
    expect(JSON.parse(readFiles(contractHome).settings)).toEqual({
      keep: true,
      modelProvider: 'gemini',
      enableTerminalSandbox: false,
      artifactReviewPolicy: 'always-proceed',
    });
  });

  it('writes settings and MCP config exactly once per query through the factory-wrapped provider', async () => {
    await import('./index.js');
    await import('../provider-contracts/index.js');
    const { createProvider } = await import('./factory.js');
    const { registerProviderMemorySessionHook } = await import('../provider-contracts/realize.js');

    const originalDeps = { ...defaultAntigravityRuntimeDeps };
    let legacyWrites = 0;
    const rules: unknown[] = [];
    const renameSpy = spyOn(fs, 'renameSync');
    Object.assign(defaultAntigravityRuntimeDeps, {
      writeRuntimeFiles: (config: AntigravityMcpConfig) => {
        legacyWrites += 1;
        originalDeps.writeRuntimeFiles(config);
      },
      prepareRules: async (hook: unknown) => {
        rules.push(hook);
      },
      spawnAgy: () => {
        throw new Error('spawn stopped by test');
      },
    } satisfies Partial<AntigravityRuntimeDeps>);
    try {
      const provider = createProvider('antigravity', { mcpServers: SERVERS, model: 'gemini-3.8-flash-medium' });
      registerProviderMemorySessionHook('antigravity', provider, {
        command: MEMORY_HOOK.command,
        legacyCommands: [],
        sources: ['startup', 'clear', 'compact'],
      });

      const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
      await expect(query.events.next()).rejects.toThrow('spawn stopped by test');

      const written = renameSpy.mock.calls.map((call) => path.basename(String(call[1])));
      expect(written.filter((name) => name === 'settings.json')).toHaveLength(1);
      expect(written.filter((name) => name === 'mcp_config.json')).toHaveLength(1);
      expect(legacyWrites).toBe(0);
      expect(JSON.parse(readFiles(home).mcp)).toEqual(antigravityMcpServersSection(SERVERS));
      // The memory capability's resolved section reaches the provider.
      expect(rules).toEqual([
        { command: MEMORY_HOOK.command, legacyCommands: [], sources: ['startup', 'clear', 'compact'] },
      ]);
    } finally {
      renameSpy.mockRestore();
      Object.assign(defaultAntigravityRuntimeDeps, originalDeps);
    }
  });

  it("hands each exchange to core's shared archive through the factory-wrapped provider", async () => {
    const archive = await import('../provider-contracts/exchange-archive.js');
    const archiveSpy = spyOn(archive, 'archiveProviderExchange').mockReturnValue('archived.md');
    try {
      await import('./index.js');
      await import('../provider-contracts/index.js');
      const { createProvider } = await import('./factory.js');
      const provider = createProvider('antigravity', { mcpServers: SERVERS });
      provider.onExchangeComplete?.({ prompt: 'hello', result: 'world', continuation: 'conv-1', status: 'completed' });

      expect(archiveSpy).toHaveBeenCalledTimes(1);
      expect(archiveSpy.mock.calls[0]?.[0]).toMatchObject({
        provider: 'antigravity',
        prompt: 'hello',
        result: 'world',
        continuation: 'conv-1',
        status: 'completed',
      });
    } finally {
      archiveSpy.mockRestore();
    }
  });

  it('archives a real exchange file titled for Antigravity', async () => {
    await import('./index.js');
    await import('../provider-contracts/index.js');
    const { createProvider } = await import('./factory.js');
    const conversations = path.join(home, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversations;
    try {
      createProvider('antigravity').onExchangeComplete?.({
        prompt: 'hello',
        result: 'world',
        continuation: 'conv-1',
        status: 'completed',
      });
      const files = fs.readdirSync(conversations);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/-antigravity-conv-1\.md$/);
      expect(fs.readFileSync(path.join(conversations, files[0]), 'utf-8')).toContain('# Antigravity Conversation');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
    }
  });
});
