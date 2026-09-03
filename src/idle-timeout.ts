/**
 * Idle-timeout resolution — how long a running container may produce *nothing*
 * before the host sweep kills it.
 *
 * This is an idle timeout, not a cap on how long a turn may take. The
 * heartbeat file is touched on every provider stream event, so any output
 * token or tool call resets the clock. A turn that keeps producing can run for
 * hours and is never killed by this check; only a turn that goes completely
 * silent ages out.
 *
 * The 30-minute built-in default encodes hosted-inference latency: a frontier
 * provider emits stream events far more often than that, so half an hour of
 * total silence means stuck. A slow local-model backend (MLX / llama.cpp /
 * Ollama on consumer hardware) can legitimately go longer than that between
 * stream events while actively decoding one turn, so the timeout can be raised
 * install-wide with `NANOCLAW_IDLE_TIMEOUT_MS` — while the default stays
 * exactly what it always was (#3643).
 *
 * Kept free of host-sweep imports so this stays a leaf module.
 */

// Default silence a running container is allowed before it is killed (30 min).
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// The sweep runs every 60s and tolerates a claimed message for 60s, so a
// timeout below the sum of the two can kill a container on its first quiet
// tick no matter how healthy it is. Refuse anything under that.
export const MIN_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
// A timeout this long is indistinguishable from having no stuck detection at
// all: a genuinely hung container would hold its session, its claim and its
// container resources for a day. Refuse it rather than silently disabling the
// sweep's only backstop.
export const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the raw env value into ms. Returns undefined for anything that is not
 * a safe integer within [MIN, MAX], so a typo'd env var falls back to the
 * default instead of disabling the timeout or collapsing it to NaN. Callers
 * that want the operator told about a rejected value should compare this
 * against the raw string themselves — parsing stays silent so it can be used
 * from anywhere.
 */
export function parseIdleTimeoutMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isSafeInteger(n)) return undefined;
  if (n < MIN_IDLE_TIMEOUT_MS || n > MAX_IDLE_TIMEOUT_MS) return undefined;
  return n;
}

/** Effective idle timeout: NANOCLAW_IDLE_TIMEOUT_MS → built-in default. */
export function resolveIdleTimeoutMs(envRaw?: string): number {
  return parseIdleTimeoutMs(envRaw) ?? DEFAULT_IDLE_TIMEOUT_MS;
}
