/**
 * Behavior test for the Ollama MCP server (`/add-ollama-tool`).
 *
 * Runs in the container tree under Bun (`cd container/agent-runner && bun test`)
 * once the skill is applied. Two things it guards, both of which shipped broken
 * in an earlier version of this skill:
 *
 *  1. Configuration actually takes effect. The daemon URL used to come from
 *     `process.env.OLLAMA_HOST` and the operator was told to put it in `.env`,
 *     which NanoClaw never loads into `process.env` — so the URL silently stayed
 *     at the default and the management tools never appeared. The precedence
 *     cases below assert the configured value is the one used, and the live
 *     cases drive the real tools against a stub daemon on a port that is only
 *     reachable if the configuration was honored.
 *
 *  2. The management tools are gated on the flag, and on nothing else.
 *
 * No network beyond loopback: the daemon is a local stub with obviously fake
 * models, so nothing here talks to a real Ollama or to the model registry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createOllamaServer, DEFAULT_OLLAMA_HOST, resolveOllamaConfig } from './ollama-mcp-stdio.js';

describe('resolveOllamaConfig', () => {
  test('falls back to the Docker host alias with no argv and no env', () => {
    expect(resolveOllamaConfig([], {})).toEqual({ host: DEFAULT_OLLAMA_HOST, adminTools: false });
  });

  test('takes the host from argv — the channel the per-group MCP entry uses', () => {
    expect(resolveOllamaConfig(['--host', 'http://ollama.box:11434'], {}).host).toBe('http://ollama.box:11434');
    expect(resolveOllamaConfig(['--host=http://ollama.box:11434'], {}).host).toBe('http://ollama.box:11434');
  });

  test('honors OLLAMA_* from its own environment as a second-choice source', () => {
    const config = resolveOllamaConfig([], {
      OLLAMA_HOST: 'http://from-env:11434',
      OLLAMA_ADMIN_TOOLS: 'true',
    });
    expect(config).toEqual({ host: 'http://from-env:11434', adminTools: true });
  });

  test('argv wins over the environment', () => {
    const config = resolveOllamaConfig(['--host', 'http://from-argv:11434', '--no-admin-tools'], {
      OLLAMA_HOST: 'http://from-env:11434',
      OLLAMA_ADMIN_TOOLS: 'true',
    });
    expect(config).toEqual({ host: 'http://from-argv:11434', adminTools: false });
  });

  test('only the exact string "true" enables the management tools via env', () => {
    expect(resolveOllamaConfig([], { OLLAMA_ADMIN_TOOLS: '1' }).adminTools).toBe(false);
    expect(resolveOllamaConfig([], { OLLAMA_ADMIN_TOOLS: 'yes' }).adminTools).toBe(false);
    expect(resolveOllamaConfig(['--admin-tools'], {}).adminTools).toBe(true);
  });

  test('trims trailing slashes so the API path is never doubled', () => {
    expect(resolveOllamaConfig(['--host', 'http://ollama.box:11434/'], {}).host).toBe('http://ollama.box:11434');
  });

  test('rejects a malformed invocation instead of silently using the default', () => {
    expect(() => resolveOllamaConfig(['--host'], {})).toThrow(/--host requires a URL/);
    expect(() => resolveOllamaConfig(['--host', '--admin-tools'], {})).toThrow(/--host requires a URL/);
    expect(() => resolveOllamaConfig(['--hostt', 'x'], {})).toThrow(/unknown argument/);
  });
});

// --- stub Ollama daemon -----------------------------------------------------

const library = new Map<string, { size: number; details: Record<string, string> }>([
  ['stub-tiny:1b', { size: 1_234_567_890, details: { family: 'stubllama', parameter_size: '1.0B', quantization_level: 'Q4_0' } }],
  ['stub-coder:7b', { size: 7_000_000_000, details: { family: 'stubqwen', parameter_size: '7.0B', quantization_level: 'Q8_0' } }],
]);

let daemon: ReturnType<typeof Bun.serve> | undefined;
let host = '';

beforeAll(() => {
  daemon = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body: Record<string, string> = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      const json = (status: number, value: unknown) => Response.json(value, { status });

      if (req.method === 'GET' && url.pathname === '/api/tags') {
        return json(200, {
          models: [...library].map(([name, m]) => ({ name, size: m.size, details: m.details })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/ps') {
        // One model "warm", loaded entirely on CPU.
        return json(200, { models: [{ name: 'stub-tiny:1b', size: 1_234_567_890, size_vram: 0 }] });
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        if (!library.has(body.model!)) return json(404, { error: `model '${body.model}' not found` });
        return json(200, {
          model: body.model,
          response: `STUB-ANSWER(${body.model}): ${String(body.prompt ?? '').slice(0, 60)}`,
          eval_count: 42,
          done: true,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/pull') {
        library.set(body.model!, { size: 999_000_000, details: { family: 'stubpulled', parameter_size: '0.9B' } });
        return json(200, { status: 'success' });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/delete') {
        if (!library.delete(body.model!)) return json(404, { error: 'model not found' });
        return json(200, {});
      }
      if (req.method === 'POST' && url.pathname === '/api/show') {
        const model = library.get(body.model!);
        if (!model) return json(404, { error: 'model not found' });
        return json(200, {
          parameters: 'temperature 0.7',
          template: '{{ .Prompt }}',
          details: model.details,
        });
      }
      return json(404, { error: 'not found' });
    },
  });
  host = `http://127.0.0.1:${daemon.port}`;
});

afterAll(() => {
  daemon?.stop(true);
});

/** Connect an MCP client to a server built from `argv`, as the spawn would. */
async function connect(argv: string[]): Promise<Client> {
  const server = createOllamaServer(resolveOllamaConfig(argv, {}));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ollama-mcp-stdio.test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? '';
}

describe('tool surface', () => {
  test('without the flag only list + generate are exposed', async () => {
    const client = await connect(['--host', host]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['ollama_generate', 'ollama_list_models']);
    await client.close();
  });

  test('with the flag all six are exposed', async () => {
    const client = await connect(['--host', host, '--admin-tools']);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ollama_delete_model',
      'ollama_generate',
      'ollama_list_models',
      'ollama_list_running',
      'ollama_pull_model',
      'ollama_show_model',
    ]);
    await client.close();
  });
});

describe('tools against a stub daemon', () => {
  test('the configured host is the one actually called', async () => {
    const client = await connect(['--host', host]);
    const out = firstText(await client.callTool({ name: 'ollama_list_models', arguments: {} }));
    expect(out).toContain('stub-tiny:1b');
    expect(out).toContain('1.1GB stubllama 1.0B');
    await client.close();
  });

  test('generate returns the daemon response plus a metadata footer', async () => {
    const client = await connect(['--host', host]);
    const out = firstText(
      await client.callTool({
        name: 'ollama_generate',
        arguments: { model: 'stub-tiny:1b', prompt: 'capital of France?' },
      }),
    );
    expect(out).toContain('STUB-ANSWER(stub-tiny:1b): capital of France?');
    expect(out).toContain('42 tokens');
    await client.close();
  });

  test('an unknown model surfaces the daemon 404 as a tool error', async () => {
    const client = await connect(['--host', host]);
    const result = await client.callTool({
      name: 'ollama_generate',
      arguments: { model: 'not-installed:1b', prompt: 'hi' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('404');
    await client.close();
  });

  test('management tools round-trip pull, show, list-running and delete', async () => {
    const client = await connect(['--host', host, '--admin-tools']);

    expect(firstText(await client.callTool({ name: 'ollama_pull_model', arguments: { model: 'stub-pulled:0.5b' } }))).toContain(
      'Pulled stub-pulled:0.5b: success',
    );
    expect(firstText(await client.callTool({ name: 'ollama_show_model', arguments: { model: 'stub-pulled:0.5b' } }))).toContain(
      'Family: stubpulled',
    );
    expect(firstText(await client.callTool({ name: 'ollama_list_running', arguments: {} }))).toContain(
      'stub-tiny:1b (1.1GB, CPU)',
    );
    expect(firstText(await client.callTool({ name: 'ollama_delete_model', arguments: { model: 'stub-pulled:0.5b' } }))).toContain(
      'Deleted stub-pulled:0.5b.',
    );

    const deleted = await client.callTool({ name: 'ollama_delete_model', arguments: { model: 'stub-pulled:0.5b' } });
    expect(deleted.isError).toBe(true);
    await client.close();
  });

  test('an unreachable daemon reports the host it tried, not a bare failure', async () => {
    // Port 1 is never listening; the message must name the configured URL so a
    // misconfigured --host is diagnosable from the agent transcript alone.
    const client = await connect(['--host', 'http://127.0.0.1:1']);
    const result = await client.callTool({ name: 'ollama_list_models', arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Failed to connect to Ollama at http://127.0.0.1:1');
    await client.close();
  });
});
