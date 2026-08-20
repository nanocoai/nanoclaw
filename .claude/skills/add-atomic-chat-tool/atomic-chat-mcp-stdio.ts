/**
 * Atomic Chat MCP server for NanoClaw.
 *
 * Exposes the local Atomic Chat desktop app's OpenAI-compatible `/v1` API as
 * two tools for the container agent: list the models it has loaded, and
 * generate with one of them.
 *
 * Wiring: this file is registered per agent group as an MCP server in the
 * group's container config (`ncl groups config add-mcp-server`), so the
 * agent-runner spawns it as `bun run /app/src/atomic-chat-mcp-stdio.ts` with
 * the `env` recorded on that entry. Nothing here reads the host's process
 * environment or `.env` — `ATOMIC_CHAT_HOST` arrives through the config entry,
 * which is the only supported per-group configuration seam.
 *
 * Everything below is a pure function of an `AtomicChatConfig`, and the stdio
 * transport is only connected when the file is run as a program. That keeps
 * the request/response handling behavior-testable (`atomic-chat-mcp-stdio.test.ts`)
 * without any network or MCP transport.
 */

import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const DEFAULT_ATOMIC_CHAT_HOST = 'http://host.docker.internal:1337';
const STATUS_FILE = '/workspace/ipc/atomic_chat_status.json';

/**
 * The MCP tool-result shape both handlers return. The open index signature is
 * what the SDK's `CallToolResult` requires of a tool callback's return type.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AtomicChatConfig {
  /** Base URL of the Atomic Chat API, without the `/v1` suffix. */
  host: string;
  /** Bearer token, or '' for a plain local Atomic Chat (the normal case). */
  apiKey: string;
  fetchImpl: FetchLike;
  log: (msg: string) => void;
  writeStatus: (status: string, detail?: string) => void;
}

function stderrLog(msg: string): void {
  // The host surfaces `[ATOMIC]` container-stderr lines at info level.
  console.error(`[ATOMIC] ${msg}`);
}

function fileStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, STATUS_FILE);
  } catch {
    /* best-effort */
  }
}

/**
 * Build a config from this process's environment. In production that
 * environment is exactly the `env` map on the group's MCP server entry (plus
 * whatever the provider's spawn inherits), never the host's `.env`.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): AtomicChatConfig {
  return {
    host: (env.ATOMIC_CHAT_HOST || DEFAULT_ATOMIC_CHAT_HOST).replace(/\/+$/, ''),
    apiKey: env.ATOMIC_CHAT_API_KEY || '',
    fetchImpl: (url, init) => fetch(url, init),
    log: stderrLog,
    writeStatus: fileStatus,
  };
}

/**
 * One request against the Atomic Chat API. `host.docker.internal` does not
 * resolve on every runtime, so a connection failure against it retries once
 * on `localhost` — the same service seen from a host-network container.
 */
export async function atomicFetch(cfg: AtomicChatConfig, apiPath: string, options?: RequestInit): Promise<Response> {
  const url = `${cfg.host}${apiPath}`;
  const headers: Record<string, string> = { ...((options?.headers as Record<string, string>) || {}) };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const finalOptions: RequestInit = { ...options, headers };
  try {
    return await cfg.fetchImpl(url, finalOptions);
  } catch (err) {
    if (cfg.host.includes('host.docker.internal')) {
      return await cfg.fetchImpl(url.replace('host.docker.internal', 'localhost'), finalOptions);
    }
    throw err;
  }
}

function textResult(text: string, isError?: boolean): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export async function listModels(cfg: AtomicChatConfig): Promise<ToolResult> {
  cfg.log('Listing models...');
  cfg.writeStatus('listing', 'Listing available models');
  try {
    const res = await atomicFetch(cfg, '/v1/models');
    if (!res.ok) {
      return textResult(`Atomic Chat API error: ${res.status} ${res.statusText}`, true);
    }
    const data = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    const models = data.data ?? [];
    if (models.length === 0) {
      return textResult('No models available. Open Atomic Chat on the host and download a model from the Hub.');
    }
    const list = models.map((m) => `- ${m.id}${m.owned_by ? ` (${m.owned_by})` : ''}`).join('\n');
    cfg.log(`Found ${models.length} models`);
    return textResult(`Available models:\n${list}`);
  } catch (err) {
    return textResult(
      `Failed to connect to Atomic Chat at ${cfg.host}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

export interface GenerateArgs {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function generate(cfg: AtomicChatConfig, args: GenerateArgs): Promise<ToolResult> {
  cfg.log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
  cfg.writeStatus('generating', `Generating with ${args.model}`);
  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (args.system) messages.push({ role: 'system', content: args.system });
    messages.push({ role: 'user', content: args.prompt });

    const body: Record<string, unknown> = { model: args.model, messages, stream: false };
    if (args.temperature !== undefined) body.temperature = args.temperature;
    if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

    const startedAt = Date.now();
    const res = await atomicFetch(cfg, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return textResult(`Atomic Chat error (${res.status}): ${errorText}`, true);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const response = data.choices?.[0]?.message?.content ?? '';
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const completionTokens = data.usage?.completion_tokens;
    const meta = `\n\n[${args.model} | ${elapsedSec}s${completionTokens !== undefined ? ` | ${completionTokens} tokens` : ''}]`;

    cfg.log(`<<< Done: ${args.model} | ${elapsedSec}s | ${completionTokens ?? '?'} tokens | ${response.length} chars`);
    cfg.writeStatus('done', `${args.model} | ${elapsedSec}s | ${completionTokens ?? '?'} tokens`);
    return textResult(response + meta);
  } catch (err) {
    return textResult(`Failed to call Atomic Chat: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/** The MCP server, with both tools bound to `cfg`. */
export function createAtomicChatServer(cfg: AtomicChatConfig): McpServer {
  const server = new McpServer({ name: 'atomic_chat', version: '1.0.0' });

  server.tool(
    'atomic_chat_list_models',
    'List all models available in the local Atomic Chat desktop app. Use this to see which models are loaded before calling atomic_chat_generate.',
    {},
    async () => listModels(cfg),
  );

  server.tool(
    'atomic_chat_generate',
    'Send a prompt to a local Atomic Chat model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use atomic_chat_list_models first to see available models.',
    {
      model: z.string().describe('The model ID as returned by atomic_chat_list_models (e.g. "llama3.2-3b-instruct")'),
      prompt: z.string().describe('The prompt to send to the model'),
      system: z.string().optional().describe('Optional system prompt to set model behavior'),
      temperature: z.number().optional().describe('Sampling temperature (0.0-2.0). Defaults to model default.'),
      max_tokens: z.number().optional().describe('Maximum number of tokens to generate in the response.'),
    },
    async (args) => generate(cfg, args),
  );

  return server;
}

// Run as a program (the agent-runner spawns `bun run <this file>`); importing
// it from a test connects nothing.
if (import.meta.main) {
  const cfg = configFromEnv();
  cfg.log(`Serving Atomic Chat at ${cfg.host}${cfg.apiKey ? ' (with bearer token)' : ''}`);
  await createAtomicChatServer(cfg).connect(new StdioServerTransport());
}
