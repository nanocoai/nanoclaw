/**
 * llmman MCP Server for NanoClaw
 * Exposes local llmman models (llmman's Ollama-compatible REST API, /api/*) as
 * tools for the container agent. Uses host.docker.internal to reach the host's
 * llmman daemon (`llmman serve`) from inside the container.
 *
 * Configuration:
 *   LLMMAN_HOST         where the daemon is, in llmman's own spelling
 *                       `[scheme://][host][:port]` (default
 *                       http://host.docker.internal:17434). A loopback or
 *                       wildcard host means "the machine running Docker" here.
 *   LLMMAN_API_KEY      sent as `Authorization: Bearer` — only needed when the
 *                       daemon has LLMMAN_API_KEYS set.
 *   LLMMAN_ADMIN_TOOLS  `true` exposes the library-management tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DOCKER_HOST_NAME = 'host.docker.internal';
const DEFAULT_PORT = '17434';
const LLMMAN_API_KEY = process.env.LLMMAN_API_KEY || '';
const LLMMAN_ADMIN_TOOLS = process.env.LLMMAN_ADMIN_TOOLS === 'true';

function log(msg: string): void {
  console.error(`[LLMMAN] ${msg}`);
}

/**
 * Turn `LLMMAN_HOST` into a base URL. llmman reads the same variable as the
 * address the daemon binds to (and its CLI connects to), so it may be
 * `0.0.0.0:17434`, `:17434` or `https://llmman.example` as well as a full URL.
 * Inside a container a loopback or wildcard host would point at the container
 * itself; the daemon is on the Docker host, so those map to host.docker.internal.
 */
function resolveBaseUrl(raw: string | undefined): string {
  const fallback = `http://${DOCKER_HOST_NAME}:${DEFAULT_PORT}`;
  const spec = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!spec) return fallback;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
  let url: URL;
  try {
    url = new URL(hasScheme ? spec : `http://${spec.startsWith(':') ? '0.0.0.0' : ''}${spec}`);
  } catch {
    log(`Ignoring unparseable LLMMAN_HOST ${JSON.stringify(spec)}; using ${fallback}`);
    return fallback;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const onThisMachine =
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '::1' ||
    hostname.startsWith('127.');
  const host = onThisMachine ? DOCKER_HOST_NAME : url.host.replace(/:\d+$/, '');
  // llmman's own default: 17434 when the spec names no port and no scheme.
  const port = url.port || (hasScheme ? '' : DEFAULT_PORT);
  return `${url.protocol}//${host}${port ? `:${port}` : ''}`;
}

const LLMMAN_BASE_URL = resolveBaseUrl(process.env.LLMMAN_HOST);

async function llmmanFetch(apiPath: string, options: RequestInit = {}): Promise<Response> {
  const url = `${LLMMAN_BASE_URL}${apiPath}`;
  const headers = new Headers(options.headers);
  if (LLMMAN_API_KEY) headers.set('Authorization', `Bearer ${LLMMAN_API_KEY}`);
  const init: RequestInit = { ...options, headers };
  try {
    return await fetch(url, init);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails (e.g. host networking)
    if (LLMMAN_BASE_URL.includes(DOCKER_HOST_NAME)) {
      return await fetch(url.replace(DOCKER_HOST_NAME, 'localhost'), init);
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

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function text(message: string): ToolResult {
  return { content: [{ type: 'text' as const, text: message }] };
}

function toolError(message: string): ToolResult {
  return { ...text(message), isError: true };
}

/** An HTTP failure: llmman answers `{"error": "..."}`; a 401 means a key is required. */
async function httpError(res: Response, what: string): Promise<ToolResult> {
  const body = await res.text();
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    /* not JSON — keep the raw body */
  }
  const hint =
    res.status === 401 ? ' (the daemon requires an API key: set LLMMAN_API_KEY to one of its LLMMAN_API_KEYS)' : '';
  return toolError(`llmman ${what} error (${res.status}): ${detail || res.statusText}${hint}`);
}

function connectError(err: unknown): ToolResult {
  return toolError(
    `Failed to connect to llmman at ${LLMMAN_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * llmman pulls a model it does not have from a registry on demand, so
 * llmman_generate on an unknown name would download it. Pulling is a
 * library-management action gated by LLMMAN_ADMIN_TOOLS, so without the flag a
 * name that is not already stored is refused here. /api/show resolves names the
 * way generate does (short names included) and answers 404 without pulling.
 */
async function refuseUnstored(model: string): Promise<ToolResult | undefined> {
  if (LLMMAN_ADMIN_TOOLS) return undefined;
  const res = await llmmanFetch('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (res.status === 404) {
    return toolError(
      `Model ${model} is not stored in llmman, and this agent may not download models. Use a name from llmman_list_models, or pull it on the host with \`llmman pull ${model}\`.`,
    );
  }
  if (!res.ok) return await httpError(res, 'show');
  return undefined;
}

const server = new McpServer({
  name: 'llmman',
  version: '1.0.0',
});

server.tool(
  'llmman_list_models',
  'List all models stored in the local llmman daemon. Use this to see which models are available before calling llmman_generate.',
  {},
  async () => {
    log('Listing models...');
    try {
      const res = await llmmanFetch('/api/tags');
      if (!res.ok) return await httpError(res, 'API');

      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          size?: number;
          details?: {
            family?: string;
            parameter_size?: string;
            quantization_level?: string;
          };
        }>;
      };
      const models = data.models || [];

      if (models.length === 0) {
        return text(
          'No models installed. Pull one on the host with `llmman pull <model>` (e.g. `llmman pull qwen3.8`).',
        );
      }

      const list = models
        .map((m) => {
          const family = m.details?.family ? ` ${m.details.family}` : '';
          const params = m.details?.parameter_size ? ` ${m.details.parameter_size}` : '';
          const quant = m.details?.quantization_level ? ` ${m.details.quantization_level}` : '';
          return `- ${m.name} (${formatBytes(m.size)}${family}${params}${quant})`;
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
  'llmman_generate',
  'Send a prompt to a local llmman model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use llmman_list_models first and pass one of its names.',
  {
    model: z
      .string()
      .describe('The model name as returned by llmman_list_models (e.g. "qwen3.8" or "docker.io/ai/gemma4:latest")'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
    temperature: z.number().optional().describe('Sampling temperature (0.0–2.0). Defaults to model default.'),
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
      if (args.temperature !== undefined) {
        body.options = { temperature: args.temperature };
      }

      const refused = await refuseUnstored(args.model);
      if (refused) return refused;

      const startedAt = Date.now();
      const res = await llmmanFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return await httpError(res, 'generate');

      const data = (await res.json()) as {
        response?: string;
        eval_count?: number;
      };

      const response = data.response ?? '';
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const evalCount = data.eval_count;

      const meta = `\n\n[${args.model} | ${elapsedSec}s${evalCount !== undefined ? ` | ${evalCount} tokens` : ''}]`;

      log(`<<< Done: ${args.model} | ${elapsedSec}s | ${evalCount ?? '?'} tokens | ${response.length} chars`);

      return text(response + meta);
    } catch (err) {
      return toolError(`Failed to call llmman: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// Library-management tools — opt-in via LLMMAN_ADMIN_TOOLS=true. These mutate
// the host's model library (pull/delete) or inspect it, so they are gated
// behind an explicit flag rather than exposed by default.
if (LLMMAN_ADMIN_TOOLS) {
  server.tool(
    'llmman_pull_model',
    'Pull (download) a model into the local llmman daemon from an OCI registry or Hugging Face. Blocks until the download completes — large models can take several minutes.',
    {
      model: z.string().describe('The model to pull (e.g. "qwen3.8" or "hf.co/unsloth/Qwen3.5-0.8B-GGUF")'),
    },
    async (args) => {
      log(`Pulling model: ${args.model}`);
      try {
        // llmman's /api/pull has no `stream` switch: it always answers with
        // newline-delimited JSON progress and ends with {"status":"success"}
        // or {"error": "..."} (still an HTTP 200). Read it to the end.
        const res = await llmmanFetch('/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) return await httpError(res, 'pull');

        let lastStatus = '';
        let failure = '';
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as { status?: string; error?: string };
            if (event.error) failure = event.error;
            else if (event.status) lastStatus = event.status;
          } catch {
            /* a progress line we cannot parse is not fatal */
          }
        }
        if (failure) return toolError(`llmman pull error: ${failure}`);
        if (lastStatus !== 'success') {
          return toolError(
            `llmman pull of ${args.model} ended without a success status (last: ${lastStatus || 'none'})`,
          );
        }
        log(`Pulled: ${args.model}`);
        return text(`Pulled ${args.model}: ${lastStatus}`);
      } catch (err) {
        return toolError(`Failed to pull ${args.model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'llmman_delete_model',
    'Delete a locally stored model from the llmman daemon to free disk space.',
    {
      model: z.string().describe('The model name to delete, as returned by llmman_list_models'),
    },
    async (args) => {
      log(`Deleting model: ${args.model}`);
      try {
        const res = await llmmanFetch('/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) return await httpError(res, 'delete');

        log(`Deleted: ${args.model}`);
        return text(`Deleted ${args.model}.`);
      } catch (err) {
        return toolError(`Failed to delete ${args.model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'llmman_show_model',
    'Show details for a locally stored model: family, parameter size, quantization, capabilities (completion, vision, tools, thinking, embedding) and chat template.',
    {
      model: z.string().describe('The model name to inspect, as returned by llmman_list_models'),
    },
    async (args) => {
      log(`Showing model: ${args.model}`);
      try {
        const res = await llmmanFetch('/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) return await httpError(res, 'show');

        const data = (await res.json()) as {
          capabilities?: string[];
          template?: string;
          details?: {
            format?: string;
            family?: string;
            parameter_size?: string;
            quantization_level?: string;
          };
        };

        const parts: string[] = [`Model: ${args.model}`];
        if (data.details) {
          const d = data.details;
          parts.push(
            `Format: ${d.format || '?'} | Family: ${d.family || '?'} | Params: ${d.parameter_size || '?'} | Quant: ${d.quantization_level || '?'}`,
          );
        }
        if (data.capabilities?.length) {
          parts.push(`Capabilities: ${data.capabilities.join(', ')}`);
        }
        if (data.template) parts.push(`Template:\n${data.template}`);

        return text(parts.join('\n\n'));
      } catch (err) {
        return toolError(`Failed to show ${args.model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'llmman_list_running',
    'List models currently loaded by the llmman daemon, with size, serving engine, context window and when each unloads. Use this to see what is warm and consuming resources.',
    {},
    async () => {
      log('Listing running models...');
      try {
        const res = await llmmanFetch('/api/ps');
        if (!res.ok) return await httpError(res, 'API');

        // llmman does not track GPU memory (size_vram is always 0); it names
        // the serving engine in `processor` instead (e.g. "llama-server (local)").
        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            size?: number;
            processor?: string;
            context_length?: number | null;
            expires_at?: string | null;
          }>;
        };
        const models = data.models || [];

        if (models.length === 0) {
          return text('No models currently loaded in memory.');
        }

        const list = models
          .map((m) => {
            const details = [
              formatBytes(m.size),
              m.processor || undefined,
              m.context_length ? `ctx ${m.context_length}` : undefined,
              m.expires_at ? `unloads ${m.expires_at}` : 'stays loaded',
            ].filter(Boolean);
            return `- ${m.name} (${details.join(', ')})`;
          })
          .join('\n');

        return text(`Loaded models:\n${list}`);
      } catch (err) {
        return connectError(err);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
