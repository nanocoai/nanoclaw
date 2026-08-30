import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getProviderFactory } from './provider-registry.js';
import { resolveOllamaRuntimeModel, withOllamaModelIdentity } from './ollama.js';

// The turn-ending rule reads destinations from the live inbound.db. Seed the two
// kinds it distinguishes rather than mocking ../destinations.js: a bun module mock
// is process-wide, and this file shares its process with the engine's own tests.
beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('helper', 'Helper', 'agent', NULL, NULL, 'ag-helper'),
              ('browser', 'Browser', 'channel', 'local-web', 'local-web:local', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('ollama container provider helpers', () => {
  it('keeps the source model in the agent-facing prompt', () => {
    const input = withOllamaModelIdentity(
      { prompt: 'hello', cwd: '/workspace/agent', systemContext: { instructions: 'base' } },
      'gemma4:12b-mlx',
    );
    expect(input.systemContext?.instructions).toContain('base');
    expect(input.systemContext?.instructions).toContain('gemma4:12b-mlx');
    expect(input.systemContext?.instructions).toContain('never the internal nanoclaw/* runtime alias');
  });

  it('uses the launch alias only for the provider runtime', () => {
    expect(
      resolveOllamaRuntimeModel({
        model: 'gemma4:12b-mlx',
        env: { NANOCLAW_OLLAMA_RUNTIME_MODEL: 'nanoclaw/abc:latest' },
      }),
    ).toBe('nanoclaw/abc:latest');
    expect(resolveOllamaRuntimeModel({ model: 'gemma4:12b-mlx' })).toBe('gemma4:12b-mlx');
  });

  it('uses result-only delivery for Ollama streams', () => {
    expect(Reflect.get(getProviderFactory('ollama')({}), 'emitsMidTurnText')).toBe(false);
  });

  it('ends the turn only after a handoff whose result the model cannot see', () => {
    const provider = getProviderFactory('ollama')({}) as unknown as {
      shouldStopAfterTool(toolName: string, toolInput: Record<string, unknown>): boolean;
    };
    const stops = (toolName: string, toolInput: Record<string, unknown> = {}): boolean =>
      provider.shouldStopAfterTool(toolName, toolInput);

    expect(stops('mcp__nanoclaw__create_agent')).toBe(true);
    expect(stops('mcp__nanoclaw__send_message', { to: 'helper' })).toBe(true);
    expect(stops('mcp__nanoclaw__send_message', { to: 'browser' })).toBe(false);
    expect(stops('mcp__nanoclaw__send_message', { to: 'absent' })).toBe(false);
    expect(stops('mcp__nanoclaw__send_message', { to: 42 })).toBe(false);
    expect(stops('Bash')).toBe(false);
  });
});
