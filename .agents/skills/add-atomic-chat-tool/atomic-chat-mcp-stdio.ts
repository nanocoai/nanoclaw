/**
 * Atomic Chat MCP Server for NanoClaw
 * Exposes local Atomic Chat models (OpenAI-compatible, /v1) as tools for the container agent.
 * Uses host.docker.internal to reach the host's Atomic Chat desktop app from Docker.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const ATOMIC_CHAT_HOST =
  process.env.ATOMIC_CHAT_HOST || 'http://host.docker.internal:1337';
const ATOMIC_CHAT_API_KEY = process.env.ATOMIC_CHAT_API_KEY || '';
const ATOMIC_CHAT_STATUS_FILE = '/workspace/ipc/atomic_chat_status.json';

function log(msg: string): void {
  console.error(`[ATOMIC] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${ATOMIC_CHAT_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(ATOMIC_CHAT_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, ATOMIC_CHAT_STATUS_FILE);
  } catch {
    /* best-effort */
  }
}

async function atomicFetch(
  apiPath: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${ATOMIC_CHAT_HOST}${apiPath}`;
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (ATOMIC_CHAT_API_KEY) {
    headers.Authorization = `Bearer ${ATOMIC_CHAT_API_KEY}`;
  }
  const finalOptions: RequestInit = { ...options, headers };
  try {
    return await fetch(url, finalOptions);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (ATOMIC_CHAT_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, finalOptions);
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'atomic_chat',
  version: '1.0.0',
});

server.tool(
  'atomic_chat_list_models',
  'List all models available in the local Atomic Chat desktop app. Use this to see which models are loaded before calling atomic_chat_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await atomicFetch('/v1/models');
      if (!res.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Atomic Chat API error: ${res.status} ${res.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };
      const models = data.data || [];

      if (models.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No models available. Open Atomic Chat on the host and download a model from the Hub.',
            },
          ],
        };
      }

      const list = models
        .map((m) => `- ${m.id}${m.owned_by ? ` (${m.owned_by})` : ''}`)
        .join('\n');

      log(`Found ${models.length} models`);
      return {
        content: [
          { type: 'text' as const, text: `Available models:\n${list}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to connect to Atomic Chat at ${ATOMIC_CHAT_HOST}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'atomic_chat_generate',
  'Send a prompt to a local Atomic Chat model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use atomic_chat_list_models first to see available models.',
  {
    model: z
      .string()
      .describe(
        'The model ID as returned by atomic_chat_list_models (e.g. "llama3.2-3b-instruct")',
      ),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z
      .string()
      .optional()
      .describe('Optional system prompt to set model behavior'),
    temperature: z
      .number()
      .optional()
      .describe('Sampling temperature (0.0–2.0). Defaults to model default.'),
    max_tokens: z
      .number()
      .optional()
      .describe('Maximum number of tokens to generate in the response.'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (args.system) {
        messages.push({ role: 'system', content: args.system });
      }
      messages.push({ role: 'user', content: args.prompt });

      const body: Record<string, unknown> = {
        model: args.model,
        messages,
        stream: false,
      };
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

      const startedAt = Date.now();
      const res = await atomicFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Atomic Chat error (${res.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const response = data.choices?.[0]?.message?.content ?? '';
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const completionTokens = data.usage?.completion_tokens;

      const meta = `\n\n[${args.model} | ${elapsedSec}s${
        completionTokens !== undefined ? ` | ${completionTokens} tokens` : ''
      }]`;

      log(
        `<<< Done: ${args.model} | ${elapsedSec}s | ${
          completionTokens ?? '?'
        } tokens | ${response.length} chars`,
      );
      writeStatus(
        'done',
        `${args.model} | ${elapsedSec}s | ${completionTokens ?? '?'} tokens`,
      );

      return { content: [{ type: 'text' as const, text: response + meta }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to call Atomic Chat: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
