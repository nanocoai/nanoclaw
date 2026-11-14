import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requests: Array<{ path: string; body?: unknown }> = [];
let fail = false;
const http = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push({ path, body: req.method === 'POST' ? await req.json() : undefined });
    if (fail) return new Response('private server diagnostic', { status: 503 });
    if (path === '/v1/models') return Response.json({ data: [{ id: 'test-model', context_window: 8192 }] });
    if (path === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: 'Paris' } }] });
    if (path === '/health') return Response.json({ status: 'ok' });
    return new Response(null, { status: 404 });
  },
});
const client = new Client({ name: 'rapid-mlx-test', version: '1.0.0' });
beforeAll(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['run', `${import.meta.dir}/rapid-mlx-mcp-stdio.ts`],
      env: { RAPID_MLX_BASE_URL: `http://127.0.0.1:${http.port}/v1/` },
      stderr: 'pipe',
    }),
  );
});
afterAll(async () => {
  await client.close();
  http.stop(true);
});

describe('Rapid-MLX MCP transport and tools', () => {
  test('advertises the three tools through a real stdio handshake', async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      'rapid_mlx_chat',
      'rapid_mlx_list_models',
      'rapid_mlx_server_status',
    ]);
  });
  test('lists served model IDs', async () => {
    const result = await client.callTool({ name: 'rapid_mlx_list_models', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'test-model' }]);
  });
  test('sends the OpenAI chat payload and returns text', async () => {
    const result = await client.callTool({
      name: 'rapid_mlx_chat',
      arguments: {
        model: 'test-model',
        message: 'Capital of France?',
        system: 'Be brief.',
        max_tokens: 32,
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Paris' }]);
    expect(requests.at(-1)).toEqual({
      path: '/v1/chat/completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Capital of France?' },
        ],
        max_tokens: 32,
        stream: false,
      },
    });
  });
  test('checks health at the origin rather than under /v1', async () => {
    const result = await client.callTool({ name: 'rapid_mlx_server_status', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(requests.at(-1)?.path).toBe('/health');
  });
  test('rejects invalid token limits before making a request', async () => {
    const count = requests.length;
    const result = await client.callTool({
      name: 'rapid_mlx_chat',
      arguments: {
        model: 'test-model',
        message: 'hello',
        max_tokens: -1,
      },
    });
    expect(result.isError).toBe(true);
    expect(requests.length).toBe(count);
  });
  test('reports HTTP errors without exposing response bodies', async () => {
    fail = true;
    try {
      const result = await client.callTool({ name: 'rapid_mlx_list_models', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private server diagnostic');
    } finally {
      fail = false;
    }
  });
});
