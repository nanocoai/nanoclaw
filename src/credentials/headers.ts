/**
 * Internal NanoClaw attribution headers.
 *
 * Containers (and any future credential proxy) send these so the gateway /
 * resolver can attribute requests to the right (agent group, runtime
 * provider, model provider, model). They must be stripped before forwarding
 * to upstream APIs — leaking internal hints to vendor backends is bad
 * hygiene and may break vendor SDKs that reject unknown headers.
 *
 * Stable wire constants — changing them breaks deployed containers / proxies.
 */
export const NANOCLAW_HEADER_AGENT_GROUP = 'x-nanoclaw-agent-group';
export const NANOCLAW_HEADER_RUNTIME_PROVIDER = 'x-nanoclaw-runtime-provider';
export const NANOCLAW_HEADER_MODEL_PROVIDER = 'x-nanoclaw-model-provider';
export const NANOCLAW_HEADER_MODEL = 'x-nanoclaw-model';

export const NANOCLAW_INTERNAL_HEADERS = [
  NANOCLAW_HEADER_AGENT_GROUP,
  NANOCLAW_HEADER_RUNTIME_PROVIDER,
  NANOCLAW_HEADER_MODEL_PROVIDER,
  NANOCLAW_HEADER_MODEL,
] as const;

const INTERNAL_HEADER_SET = new Set<string>(NANOCLAW_INTERNAL_HEADERS);

export type HeaderMap = Record<string, string | number | string[] | undefined>;

/**
 * Return a new header map with all internal NanoClaw headers removed.
 * Case-insensitive on the input key. Non-mutating.
 */
export function stripNanoclawHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    if (INTERNAL_HEADER_SET.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
