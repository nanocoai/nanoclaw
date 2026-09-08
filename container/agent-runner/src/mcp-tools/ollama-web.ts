import { isIP } from 'node:net';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_URL_CHARS = 2_048;
const MAX_CONTENT_CHARS = 100_000;
const MAX_LINKS = 100;
const FETCH_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

type OllamaFetchResult = { ok: true; text: string } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrivateIpLiteral(hostname: string): boolean {
  const candidate = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const version = isIP(candidate);
  if (version === 4) {
    const [a, b] = candidate.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = candidate.toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return normalized === '::' || normalized === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function parsePublicWebUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIpLiteral(hostname)) return null;
  return url;
}

function errorForStatus(status: number, body: Record<string, unknown>): string {
  const detail = typeof body.error === 'string' ? ` (${body.error})` : '';
  if (status === 401) {
    const signin =
      typeof body.signin_url === 'string'
        ? ` Sign in on the host: ${body.signin_url}`
        : ' Run `ollama signin` on the host.';
    return `Ollama browsing is not signed in.${signin}`;
  }
  if (status === 403) return `Ollama Cloud is disabled${detail}. Enable Cloud on the host, then retry.`;
  if (status === 404) return `Ollama Web Fetch could not fetch that URL${detail}. Try another result or URL.`;
  if (status === 429)
    return 'Ollama browsing usage is exhausted or rate-limited. Check the Ollama account usage, then retry.';
  return `Ollama Web Fetch failed with HTTP ${status}${detail}.`;
}

export async function fetchOllamaWebPage(
  args: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
  baseUrl = process.env.ANTHROPIC_BASE_URL,
): Promise<OllamaFetchResult> {
  const target = parsePublicWebUrl(args.url);
  if (!target) return { ok: false, message: 'WebFetch requires a public HTTP(S) URL without credentials.' };
  if (!baseUrl) return { ok: false, message: 'The local Ollama daemon URL is not configured.' };

  let endpoint: URL;
  try {
    endpoint = new URL('/api/experimental/web_fetch', baseUrl);
  } catch {
    return { ok: false, message: 'The local Ollama daemon URL is invalid.' };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: target.toString() }),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach Ollama Web Fetch (${message}).` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) {
      return {
        ok: false,
        message: 'This Ollama version does not provide the local Web Fetch proxy. Update Ollama, then retry.',
      };
    }
    return { ok: false, message: `Ollama Web Fetch returned invalid JSON (HTTP ${response.status}).` };
  }
  const record = isRecord(body) ? body : {};
  if (!response.ok) return { ok: false, message: errorForStatus(response.status, record) };

  if (
    typeof record.title !== 'string' ||
    typeof record.content !== 'string' ||
    (record.links !== undefined && !Array.isArray(record.links))
  ) {
    return { ok: false, message: 'Ollama Web Fetch returned an unexpected response shape.' };
  }

  const contentWasTruncated = record.content.length > MAX_CONTENT_CHARS;
  const content = record.content.slice(0, MAX_CONTENT_CHARS);
  const links = (record.links ?? [])
    .filter((link): link is string => typeof link === 'string')
    .slice(0, MAX_LINKS)
    .map((link) => link.slice(0, MAX_URL_CHARS));
  const text = [
    `Title: ${record.title.slice(0, 500)}`,
    `URL: ${target.toString()}`,
    '',
    content,
    ...(contentWasTruncated ? ['', `[Content truncated at ${MAX_CONTENT_CHARS} characters]`] : []),
    ...(links.length > 0 ? ['', 'Links:', ...links.map((link) => `- ${link}`)] : []),
  ].join('\n');

  return { ok: true, text };
}

export const ollamaWebFetch: McpToolDefinition = {
  tool: {
    name: 'ollama_web_fetch',
    description:
      "Fetch a public web page through Ollama's signed hosted Web Fetch service. The parent model applies the supplied prompt to the returned title, main content, and links.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTP(S) URL to fetch' },
        prompt: { type: 'string', description: 'What information to extract from the fetched page' },
      },
      required: ['url', 'prompt'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async handler(args) {
    const result = await fetchOllamaWebPage(args);
    return result.ok
      ? { content: [{ type: 'text', text: result.text }] }
      : { content: [{ type: 'text', text: `Error: ${result.message}` }], isError: true };
  },
};

if (process.env.NANOCLAW_OLLAMA_WEB_BROWSING === 'enabled') {
  registerTools([ollamaWebFetch]);
}
