/**
 * Ollama MCP Server for NanoClaw
 * Exposes local Ollama models (native Ollama REST API, /api/*) as tools for the
 * container agent. Uses host.docker.internal to reach the host's Ollama daemon
 * from inside the container.
 *
 * Ollama runs locally and is keyless — there are no credentials to thread. The
 * only configuration is the base URL (OLLAMA_HOST) and an opt-in flag for the
 * library-management tools (OLLAMA_ADMIN_TOOLS).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const OLLAMA_HOST =
  process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS === 'true';
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch {
    /* best-effort */
  }
}

async function ollamaFetch(
  apiPath: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${OLLAMA_HOST}${apiPath}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (OLLAMA_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '?';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)}MB`;
}

const server = new McpServer({
  name: 'ollama',
  version: '1.0.0',
});

server.tool(
  'ollama_list_models',
  'List all models installed in the local Ollama daemon. Use this to see which models are available before calling ollama_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing installed models');
    try {
      const res = await ollamaFetch('/api/tags');
      if (!res.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Ollama API error: ${res.status} ${res.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          size?: number;
          details?: { family?: string; parameter_size?: string };
        }>;
      };
      const models = data.models || [];

      if (models.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No models installed. Pull one on the host with `ollama pull <model>` (e.g. `ollama pull llama3.2`).',
            },
          ],
        };
      }

      const list = models
        .map((m) => {
          const family = m.details?.family ? ` ${m.details.family}` : '';
          const params = m.details?.parameter_size
            ? ` ${m.details.parameter_size}`
            : '';
          return `- ${m.name} (${formatBytes(m.size)}${family}${params})`;
        })
        .join('\n');

      log(`Found ${models.length} models`);
      return {
        content: [
          { type: 'text' as const, text: `Installed models:\n${list}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
  {
    model: z
      .string()
      .describe(
        'The model name as returned by ollama_list_models (e.g. "llama3.2" or "gemma3:1b")',
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
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
      };
      if (args.system) body.system = args.system;
      if (args.temperature !== undefined) {
        body.options = { temperature: args.temperature };
      }

      const startedAt = Date.now();
      const res = await ollamaFetch('/api/generate', {
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
              text: `Ollama error (${res.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const data = (await res.json()) as {
        response?: string;
        eval_count?: number;
      };

      const response = data.response ?? '';
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const evalCount = data.eval_count;

      const meta = `\n\n[${args.model} | ${elapsedSec}s${
        evalCount !== undefined ? ` | ${evalCount} tokens` : ''
      }]`;

      log(
        `<<< Done: ${args.model} | ${elapsedSec}s | ${
          evalCount ?? '?'
        } tokens | ${response.length} chars`,
      );
      writeStatus(
        'done',
        `${args.model} | ${elapsedSec}s | ${evalCount ?? '?'} tokens`,
      );

      return { content: [{ type: 'text' as const, text: response + meta }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Library-management tools — opt-in via OLLAMA_ADMIN_TOOLS=true. These mutate
// the host's model library (pull/delete) or inspect it, so they are gated
// behind an explicit flag rather than exposed by default.
if (OLLAMA_ADMIN_TOOLS) {
  server.tool(
    'ollama_pull_model',
    'Pull (download) a model from the Ollama registry into the local daemon. Blocks until the download completes — large models can take several minutes.',
    {
      model: z
        .string()
        .describe('The model name to pull (e.g. "llama3.2" or "qwen3-coder:30b")'),
    },
    async (args) => {
      log(`Pulling model: ${args.model}`);
      writeStatus('pulling', `Pulling ${args.model}`);
      try {
        const res = await ollamaFetch('/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model, stream: false }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama pull error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as { status?: string };
        log(`Pulled: ${args.model} (${data.status ?? 'ok'})`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Pulled ${args.model}: ${data.status ?? 'success'}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to pull ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_delete_model',
    'Delete a locally installed model from the Ollama daemon to free disk space.',
    {
      model: z.string().describe('The model name to delete (e.g. "gemma3:1b")'),
    },
    async (args) => {
      log(`Deleting model: ${args.model}`);
      writeStatus('deleting', `Deleting ${args.model}`);
      try {
        const res = await ollamaFetch('/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama delete error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }

        log(`Deleted: ${args.model}`);
        return {
          content: [
            { type: 'text' as const, text: `Deleted ${args.model}.` },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_show_model',
    'Show details for a locally installed model: modelfile, parameters, template, and architecture info.',
    {
      model: z
        .string()
        .describe('The model name to inspect (e.g. "llama3.2")'),
    },
    async (args) => {
      log(`Showing model: ${args.model}`);
      try {
        const res = await ollamaFetch('/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama show error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as {
          parameters?: string;
          template?: string;
          details?: {
            family?: string;
            parameter_size?: string;
            quantization_level?: string;
          };
        };

        const parts: string[] = [`Model: ${args.model}`];
        if (data.details) {
          const d = data.details;
          parts.push(
            `Family: ${d.family ?? '?'} | Params: ${d.parameter_size ?? '?'} | Quant: ${d.quantization_level ?? '?'}`,
          );
        }
        if (data.parameters) parts.push(`Parameters:\n${data.parameters}`);
        if (data.template) parts.push(`Template:\n${data.template}`);

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to show ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_list_running',
    'List models currently loaded in memory, with memory usage and processor type (CPU/GPU). Use this to see what is warm and consuming resources.',
    {},
    async () => {
      log('Listing running models...');
      try {
        const res = await ollamaFetch('/api/ps');
        if (!res.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama API error: ${res.status} ${res.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            size?: number;
            size_vram?: number;
          }>;
        };
        const models = data.models || [];

        if (models.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No models currently loaded in memory.',
              },
            ],
          };
        }

        const list = models
          .map((m) => {
            const vram = m.size_vram ?? 0;
            const total = m.size ?? 0;
            const processor =
              vram === 0
                ? 'CPU'
                : vram >= total
                  ? 'GPU'
                  : `${Math.round((vram / total) * 100)}% GPU`;
            return `- ${m.name} (${formatBytes(total)}, ${processor})`;
          })
          .join('\n');

        return {
          content: [
            { type: 'text' as const, text: `Loaded models:\n${list}` },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
