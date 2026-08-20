/**
 * Behavior test for the Atomic Chat MCP server's request/response handling
 * (container/Bun tree).
 *
 * `fetch` is injected, so these drive the real handlers against a stub Atomic
 * Chat API: the wire shapes the OpenAI-compatible endpoints return, the
 * error paths the agent sees as tool errors, and the bearer/fallback behavior
 * of the transport helper. No network, no MCP transport, no desktop app.
 *
 * The registration side (this file being wired into a group's container config)
 * is guarded separately by `atomic-chat-wiring.test.ts` in the host tree.
 */
import { describe, it, expect } from 'bun:test';

import {
  atomicFetch,
  configFromEnv,
  DEFAULT_ATOMIC_CHAT_HOST,
  generate,
  listModels,
  type AtomicChatConfig,
  type FetchLike,
} from './atomic-chat-mcp-stdio.js';

interface Call {
  url: string;
  init?: RequestInit;
}

function harness(
  handler: (call: Call) => Response | Promise<Response>,
  overrides: Partial<AtomicChatConfig> = {},
): { cfg: AtomicChatConfig; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  const cfg: AtomicChatConfig = {
    host: 'http://atomic.test:1337',
    apiKey: '',
    fetchImpl,
    log: (msg) => logs.push(msg),
    writeStatus: () => {},
    ...overrides,
  };
  return { cfg, calls, logs };
}

function json(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });
}

function text(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describe('configFromEnv', () => {
  it('defaults to the docker-gateway host and no bearer token', () => {
    const cfg = configFromEnv({});
    expect(cfg.host).toBe(DEFAULT_ATOMIC_CHAT_HOST);
    expect(cfg.apiKey).toBe('');
  });

  it('takes ATOMIC_CHAT_HOST from the environment the MCP entry supplies, trailing slash trimmed', () => {
    const cfg = configFromEnv({ ATOMIC_CHAT_HOST: 'http://192.168.1.9:1337/', ATOMIC_CHAT_API_KEY: 'local-token' });
    expect(cfg.host).toBe('http://192.168.1.9:1337');
    expect(cfg.apiKey).toBe('local-token');
  });
});

describe('atomicFetch', () => {
  it('sends no Authorization header when no token is configured', async () => {
    const { cfg, calls } = harness(() => json({ data: [] }));
    await atomicFetch(cfg, '/v1/models');
    expect(calls[0].url).toBe('http://atomic.test:1337/v1/models');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends a bearer header when a token is configured', async () => {
    const { cfg, calls } = harness(() => json({ data: [] }), { apiKey: 'local-proxy-token' });
    await atomicFetch(cfg, '/v1/models');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer local-proxy-token');
  });

  it('retries on localhost when host.docker.internal cannot be reached', async () => {
    const { cfg, calls } = harness(
      ({ url }) => {
        if (url.includes('host.docker.internal')) throw new Error('ENOTFOUND host.docker.internal');
        return json({ data: [] });
      },
      { host: 'http://host.docker.internal:1337' },
    );
    const res = await atomicFetch(cfg, '/v1/models');
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'http://host.docker.internal:1337/v1/models',
      'http://localhost:1337/v1/models',
    ]);
  });

  it('propagates the failure when there is no fallback host to try', async () => {
    const { cfg } = harness(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(atomicFetch(cfg, '/v1/models')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('atomic_chat_list_models', () => {
  it('renders the models Atomic Chat reports', async () => {
    const { cfg, calls, logs } = harness(() =>
      json({
        object: 'list',
        data: [{ id: 'llama3.2-3b-instruct', owned_by: 'atomic-chat' }, { id: 'qwen2.5-coder-7b' }],
      }),
    );
    const result = await listModels(cfg);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('Available models:\n- llama3.2-3b-instruct (atomic-chat)\n- qwen2.5-coder-7b');
    expect(calls[0].url).toBe('http://atomic.test:1337/v1/models');
    expect(logs.some((l) => l.includes('Found 2 models'))).toBe(true);
  });

  it('tells the operator how to fix an empty library, and does not call it an error', async () => {
    const { cfg } = harness(() => json({ data: [] }));
    const result = await listModels(cfg);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('No models available');
  });

  it('surfaces a non-OK status as a tool error', async () => {
    const { cfg } = harness(() => json({}, 503, 'Service Unavailable'));
    const result = await listModels(cfg);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Atomic Chat API error: 503 Service Unavailable');
  });

  it('surfaces a connection failure as a tool error naming the host', async () => {
    const { cfg } = harness(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await listModels(cfg);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Failed to connect to Atomic Chat at http://atomic.test:1337');
    expect(text(result)).toContain('ECONNREFUSED');
  });
});

describe('atomic_chat_generate', () => {
  it('posts an OpenAI chat-completions body and returns the content plus usage metadata', async () => {
    const { cfg, calls } = harness(() =>
      json({
        choices: [{ message: { role: 'assistant', content: 'Paris' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      }),
    );
    const result = await generate(cfg, {
      model: 'llama3.2-3b-instruct',
      prompt: 'capital of France?',
      system: 'Answer in one word.',
      temperature: 0.2,
      max_tokens: 16,
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Paris');
    expect(text(result)).toMatch(/\[llama3\.2-3b-instruct \| \d+\.\ds \| 3 tokens\]/);

    expect(calls[0].url).toBe('http://atomic.test:1337/v1/chat/completions');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({
      model: 'llama3.2-3b-instruct',
      stream: false,
      temperature: 0.2,
      max_tokens: 16,
      messages: [
        { role: 'system', content: 'Answer in one word.' },
        { role: 'user', content: 'capital of France?' },
      ],
    });
  });

  it('omits system, temperature and max_tokens when the caller did not pass them', async () => {
    const { cfg, calls } = harness(() => json({ choices: [{ message: { content: 'ok' } }] }));
    await generate(cfg, { model: 'm1', prompt: 'hi' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect('temperature' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
  });

  it('reports the API error body on a non-OK response — the 404 a wrong model id produces', async () => {
    const { cfg } = harness(() => new Response('{"error":{"message":"model not found: nope"}}', { status: 404 }));
    const result = await generate(cfg, { model: 'nope', prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Atomic Chat error (404)');
    expect(text(result)).toContain('model not found: nope');
  });

  it('renders an empty completion without usage as empty text plus metadata', async () => {
    const { cfg } = harness(() => json({ choices: [] }));
    const result = await generate(cfg, { model: 'm1', prompt: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/^\n\n\[m1 \| \d+\.\ds\]$/);
  });

  it('surfaces a transport failure as a tool error', async () => {
    const { cfg } = harness(() => {
      throw new Error('socket hang up');
    });
    const result = await generate(cfg, { model: 'm1', prompt: 'hi' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Failed to call Atomic Chat: socket hang up');
  });
});
