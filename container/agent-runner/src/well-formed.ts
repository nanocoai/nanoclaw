/**
 * Replace unpaired UTF-16 surrogates with U+FFFD so any string serialized into
 * an Anthropic API request body stays valid UTF-8/JSON.
 *
 * A lone surrogate — a chat message whose emoji was truncated mid-pair upstream,
 * or already-corrupt platform text (WhatsApp pushName, caption, transcript) —
 * makes the API reject the ENTIRE request with
 * `400 invalid_request_error: ... no low surrogate in string`, which would
 * otherwise wedge the whole session. Sanitizing at the request boundary catches
 * the bad char regardless of which upstream path introduced it.
 *
 * Uses the native String.prototype.toWellFormed (ES2024, present in Bun) with a
 * regex fallback for older runtimes.
 */
export function toWellFormedText(s: string): string {
  const tw = (s as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof tw === 'function') return tw.call(s);
  // Fallback: a high surrogate not followed by a low surrogate, or a low
  // surrogate not preceded by a high surrogate, becomes U+FFFD.
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT splitting a surrogate
 * pair: if the cut lands between an emoji's two halves, drop the dangling high
 * surrogate. This is the SOURCE fix for the `no low surrogate` 400 — content
 * truncated for prompt injection (memory recall, transcript excerpts) stays
 * well-formed, so the boundary sanitizer never has to replace a real emoji with
 * U+FFFD. Returns the input unchanged when it already fits.
 */
export function truncateChars(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // boundary char is a high surrogate
  return s.slice(0, end);
}

/**
 * Keep at most the LAST `max` UTF-16 code units (tail window) without starting
 * mid-pair: if the cut lands on the low half of an emoji, drop it. Mirror of
 * `truncateChars` for callers that keep the most-recent tail.
 */
export function truncateCharsTail(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  let start = s.length - max;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // boundary char is a low surrogate
  return s.slice(start);
}

/** True when `s` has no unpaired surrogate (native isWellFormed with a regex fallback). */
export function isWellFormedText(s: string): boolean {
  const iw = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof iw === 'function') return iw.call(s);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/**
 * Cheap recursive predicate: does any string in `value` contain a lone
 * surrogate? Lets the PostToolUse hook (claude.ts) skip the
 * allocate-a-clean-copy path for the overwhelming majority of well-formed tool
 * outputs — only rewriting output that actually needs it.
 */
export function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return !isWellFormedText(value);
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  if (value && typeof value === 'object') return Object.values(value).some(containsLoneSurrogate);
  return false;
}

/**
 * Recursively replace lone surrogates in every string of an MCP tool result so
 * DB/API-derived tool output (often JSON.stringify'd) can't poison the next
 * request's `tool_result` block. Walks the whole value, so it covers
 * `content[].text`, `resource.text`, `structuredContent`, and any future field —
 * not just the common text-content case. Non-string leaves pass through.
 *
 * Reaches external/config-wired MCP and built-in SDK tool output too: the
 * PostToolUse hook (providers/claude.ts) routes every SUCCESSFUL tool_response
 * through this. Tool FAILURES are partly covered: our own in-container MCP
 * tools route their thrown message through `wellFormedError` at the dispatch
 * boundary (mcp-tools/server.ts). The residual is a built-in/external tool that
 * FAILS — PostToolUseFailure carries an `error` string with no
 * `updatedToolOutput` field and those tools run in the SDK process, so a lone
 * surrogate in their error text can't be rewritten in-repo (hard SDK limit;
 * narrow — requires such a tool to fail AND its error text to be malformed).
 */
/**
 * Sanitize lone surrogates out of a THROWN error's message so it can't poison
 * the next request body. When a tool's handler throws (vs. returning a result),
 * `wellFormedToolResult` never runs — the error propagates and the SDK records
 * it (e.g. via PostToolUseFailure, which exposes no `updatedToolOutput`). For
 * our own in-container MCP tools this is the only reachable sanitization point;
 * call it at the dispatch boundary: `throw wellFormedError(err)`.
 *
 * Returns the ORIGINAL error untouched on the common (well-formed) path so the
 * stack/type is preserved; only allocates a sanitized copy when needed.
 * Built-in/external tool failures run in the SDK process and stay unreachable.
 */
export function wellFormedError(err: unknown): unknown {
  if (err instanceof Error) {
    if (isWellFormedText(err.message)) return err;
    const sanitized = new Error(toWellFormedText(err.message));
    if (typeof err.stack === 'string') sanitized.stack = toWellFormedText(err.stack);
    return sanitized;
  }
  if (typeof err === 'string') {
    return isWellFormedText(err) ? err : new Error(toWellFormedText(err));
  }
  return err;
}

export function wellFormedToolResult<T>(value: T): T {
  if (typeof value === 'string') return toWellFormedText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => wellFormedToolResult(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wellFormedToolResult(v);
    return out as unknown as T;
  }
  return value;
}
