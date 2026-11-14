/** Rapid-MLX local model tools for NanoClaw. Bun runs this file directly. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = (process.env.RAPID_MLX_BASE_URL || 'http://localhost:8000/v1').replace(/\/$/, '');

// Keep the deadline active through response-body consumption as well as headers.
async function request(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Rapid-MLX HTTP ${response.status}`);
  return response.json();
}

const server = new McpServer({ name: 'rapid_mlx', version: '1.0.0' });

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function run(action: () => Promise<string>) {
  try {
    return toolResult(await action());
  } catch {
    // Do not echo server error bodies, URLs or prompts into tool errors.
    return {
      ...toolResult('Rapid-MLX request failed. Check the server, model ID and configured base URL.'),
      isError: true,
    };
  }
}

server.tool(
  'rapid_mlx_list_models',
  'List model IDs served by Rapid-MLX. Use an exact returned ID with rapid_mlx_chat.',
  {},
  () =>
    run(async () => {
      const data = (await request(`${baseUrl}/models`)) as { data: Array<{ id: string }> };
      return data.data.length ? data.data.map((model) => model.id).join('\n') : 'No models served.';
    }),
);

server.tool(
  'rapid_mlx_chat',
  'Send a text prompt to a local Rapid-MLX model. List models first to find the served model ID.',
  {
    model: z.string().min(1),
    message: z.string().min(1),
    system: z.string().optional(),
    max_tokens: z.number().int().min(1).default(2048),
  },
  (args) =>
    run(async () => {
      const messages = [
        ...(args.system ? [{ role: 'system', content: args.system }] : []),
        { role: 'user', content: args.message },
      ];
      const data = (await request(`${baseUrl}/chat/completions`, {
        model: args.model,
        messages,
        max_tokens: args.max_tokens,
        stream: false,
      })) as { choices: Array<{ message: { content: string | null } }> };
      const content = data.choices[0]?.message.content;
      if (!content) throw new Error('No text returned');
      return content;
    }),
);

server.tool('rapid_mlx_server_status', 'Check whether the Rapid-MLX health endpoint responds successfully.', {}, () =>
  run(async () => {
    await request(new URL('/health', baseUrl).href);
    return 'Rapid-MLX health endpoint responded successfully.';
  }),
);

await server.connect(new StdioServerTransport());
