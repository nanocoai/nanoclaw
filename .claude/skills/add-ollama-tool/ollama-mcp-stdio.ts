/**
 * Ollama MCP Server for NanoClaw
 *
 * Exposes local Ollama models (native Ollama REST API, /api/*) as tools for the
 * container agent. Ollama runs locally and is keyless — there are no
 * credentials to thread. The only configuration is the daemon base URL and an
 * opt-in flag for the library-management tools.
 *
 * Configuration is passed by the per-group MCP entry that spawns this process,
 * argv first:
 *
 *   bun run /app/src/ollama-mcp-stdio.ts --host http://host.docker.internal:11434 --admin-tools
 *
 * argv is used rather than the environment because argv is the only channel an
 * MCP client is contractually required to pass through verbatim: `env` handling
 * differs between clients (some replace the child environment, some merge it),
 * and nothing forwards a host `.env` into the container in the first place —
 * NanoClaw deliberately never loads `.env` into `process.env`. OLLAMA_HOST /
 * OLLAMA_ADMIN_TOOLS are still honored when they are set in this process's own
 * environment, as a second-choice source, so an `--env` entry on the MCP config
 * also works where the client merges it.
 *
 * Resolution order per setting: argv flag → own environment → default.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Docker Desktop / `--add-host=host.docker.internal:host-gateway` route to the
 * host. Not reachable under egress lockdown, where the name is re-aliased to
 * the OneCLI gateway — see the skill's Prerequisites.
 */
export const DEFAULT_OLLAMA_HOST = 'http://host.docker.internal:11434';

export interface OllamaConfig {
  /** Base URL of the Ollama daemon, no trailing slash. */
  host: string;
  /** Whether the library-management tools (pull/delete/show/ps) are exposed. */
  adminTools: boolean;
}

/**
 * Resolve the server's configuration from argv and the environment.
 *
 * Exported (and pure) so the precedence is testable without spawning anything:
 * this is the exact seam where an earlier version of this skill silently did
 * nothing, reading only `process.env` for a value that lived in a file nothing
 * loaded.
 */
export function resolveOllamaConfig(argv: string[], env: Record<string, string | undefined>): OllamaConfig {
  let host: string | undefined;
  let adminTools: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--host') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--host requires a URL (e.g. --host http://host.docker.internal:11434)');
      }
      host = value;
      i++;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
      if (!host) throw new Error('--host= requires a URL');
    } else if (arg === '--admin-tools') {
      adminTools = true;
    } else if (arg === '--no-admin-tools') {
      adminTools = false;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  if (host === undefined && env.OLLAMA_HOST) host = env.OLLAMA_HOST;
  if (adminTools === undefined) adminTools = env.OLLAMA_ADMIN_TOOLS === 'true';

  return { host: (host ?? DEFAULT_OLLAMA_HOST).replace(/\/+$/, ''), adminTools };
}

function log(msg: string): void {
  // Stderr is where an MCP stdio server reports — stdout carries the protocol.
  // Where these lines end up is the client's business: Claude Code captures MCP
  // server stderr into its own MCP log, so do not promise they reach the host.
  console.error(`[OLLAMA] ${msg}`);
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '?';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)}MB`;
}

function text(body: string, isError?: true) {
  return {
    content: [{ type: 'text' as const, text: body }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build the MCP server for a resolved config. Exported so a test can drive the
 * real tools over an in-memory transport against a stub daemon.
 */
export function createOllamaServer(config: OllamaConfig): McpServer {
  const server = new McpServer({ name: 'ollama', version: '1.0.0' });

  const ollamaFetch = async (apiPath: string, options?: RequestInit): Promise<Response> => {
    const url = `${config.host}${apiPath}`;
    try {
      return await fetch(url, options);
    } catch (err) {
      // A container configured for Docker Desktop's host alias but running
      // with the host's network namespace reaches the daemon on localhost.
      if (config.host.includes('host.docker.internal')) {
        return await fetch(url.replace('host.docker.internal', 'localhost'), options);
      }
      throw err;
    }
  };

  const connectError = (err: unknown) =>
    text(
      `Failed to connect to Ollama at ${config.host}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );

  server.tool(
    'ollama_list_models',
    'List all models installed in the local Ollama daemon. Use this to see which models are available before calling ollama_generate.',
    {},
    async () => {
      log('Listing models...');
      try {
        const res = await ollamaFetch('/api/tags');
        if (!res.ok) return text(`Ollama API error: ${res.status} ${res.statusText}`, true);

        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            size?: number;
            details?: { family?: string; parameter_size?: string };
          }>;
        };
        const models = data.models ?? [];

        if (models.length === 0) {
          return text(
            'No models installed. Pull one on the host with `ollama pull <model>` (e.g. `ollama pull llama3.2`).',
          );
        }

        const list = models
          .map((m) => {
            const family = m.details?.family ? ` ${m.details.family}` : '';
            const params = m.details?.parameter_size ? ` ${m.details.parameter_size}` : '';
            return `- ${m.name} (${formatBytes(m.size)}${family}${params})`;
          })
          .join('\n');

        log(`Found ${models.length} models`);
        return text(`Installed models:\n${list}`);
      } catch (err) {
        return connectError(err);
      }
    },
  );

  server.tool(
    'ollama_generate',
    'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
    {
      model: z
        .string()
        .describe('The model name as returned by ollama_list_models (e.g. "llama3.2" or "gemma3:1b")'),
      prompt: z.string().describe('The prompt to send to the model'),
      system: z.string().optional().describe('Optional system prompt to set model behavior'),
      temperature: z
        .number()
        .optional()
        .describe('Sampling temperature (0.0–2.0). Defaults to model default.'),
    },
    async (args) => {
      log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
      try {
        const body: Record<string, unknown> = {
          model: args.model,
          prompt: args.prompt,
          stream: false,
        };
        if (args.system) body.system = args.system;
        if (args.temperature !== undefined) body.options = { temperature: args.temperature };

        const startedAt = Date.now();
        const res = await ollamaFetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) return text(`Ollama error (${res.status}): ${await res.text()}`, true);

        const data = (await res.json()) as { response?: string; eval_count?: number };
        const response = data.response ?? '';
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        const evalCount = data.eval_count;
        const meta = `\n\n[${args.model} | ${elapsedSec}s${
          evalCount !== undefined ? ` | ${evalCount} tokens` : ''
        }]`;

        log(
          `<<< Done: ${args.model} | ${elapsedSec}s | ${evalCount ?? '?'} tokens | ${response.length} chars`,
        );
        return text(response + meta);
      } catch (err) {
        return text(`Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  // Library-management tools — opt-in. These mutate the host's model library
  // (pull/delete) or inspect it, so they are gated rather than default.
  if (config.adminTools) {
    server.tool(
      'ollama_pull_model',
      'Pull (download) a model from the Ollama registry into the local daemon. Blocks until the download completes — large models can take several minutes.',
      {
        model: z.string().describe('The model name to pull (e.g. "llama3.2" or "qwen3-coder:30b")'),
      },
      async (args) => {
        log(`Pulling model: ${args.model}`);
        try {
          const res = await ollamaFetch('/api/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: args.model, stream: false }),
          });
          if (!res.ok) return text(`Ollama pull error (${res.status}): ${await res.text()}`, true);

          const data = (await res.json()) as { status?: string };
          log(`Pulled: ${args.model} (${data.status ?? 'ok'})`);
          return text(`Pulled ${args.model}: ${data.status ?? 'success'}`);
        } catch (err) {
          return text(
            `Failed to pull ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
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
        try {
          const res = await ollamaFetch('/api/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: args.model }),
          });
          if (!res.ok) return text(`Ollama delete error (${res.status}): ${await res.text()}`, true);

          log(`Deleted: ${args.model}`);
          return text(`Deleted ${args.model}.`);
        } catch (err) {
          return text(
            `Failed to delete ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      },
    );

    server.tool(
      'ollama_show_model',
      'Show details for a locally installed model: modelfile, parameters, template, and architecture info.',
      {
        model: z.string().describe('The model name to inspect (e.g. "llama3.2")'),
      },
      async (args) => {
        log(`Showing model: ${args.model}`);
        try {
          const res = await ollamaFetch('/api/show', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: args.model }),
          });
          if (!res.ok) return text(`Ollama show error (${res.status}): ${await res.text()}`, true);

          const data = (await res.json()) as {
            parameters?: string;
            template?: string;
            details?: { family?: string; parameter_size?: string; quantization_level?: string };
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
          return text(parts.join('\n\n'));
        } catch (err) {
          return text(
            `Failed to show ${args.model}: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
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
          if (!res.ok) return text(`Ollama API error: ${res.status} ${res.statusText}`, true);

          const data = (await res.json()) as {
            models?: Array<{ name: string; size?: number; size_vram?: number }>;
          };
          const models = data.models ?? [];
          if (models.length === 0) return text('No models currently loaded in memory.');

          const list = models
            .map((m) => {
              const vram = m.size_vram ?? 0;
              const total = m.size ?? 0;
              const processor =
                vram === 0 ? 'CPU' : vram >= total ? 'GPU' : `${Math.round((vram / total) * 100)}% GPU`;
              return `- ${m.name} (${formatBytes(total)}, ${processor})`;
            })
            .join('\n');
          return text(`Loaded models:\n${list}`);
        } catch (err) {
          return connectError(err);
        }
      },
    );
  }

  return server;
}

// Only the spawned process connects a transport; importing this module (as the
// test does) must not take over stdio.
if (import.meta.main) {
  const config = resolveOllamaConfig(process.argv.slice(2), process.env);
  log(`daemon=${config.host} adminTools=${config.adminTools}`);
  const server = createOllamaServer(config);
  await server.connect(new StdioServerTransport());
}
