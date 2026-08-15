/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

/**
 * Running token/cost total for the session, accumulated one provider turn at
 * a time. Kept here rather than in `messages_out` because usage belongs to
 * the turn, not to any one delivered message: a turn can produce several
 * messages, or none at all, and still have cost real tokens.
 *
 * Written by the poll loop, read by the host (`ncl usage`) straight off
 * outbound.db — no extra transport, and it survives container restarts
 * because the row does.
 */
const USAGE_KEY = 'token_usage';

/**
 * One turn's usage, as reported by the provider. Every field is optional
 * because providers differ in what they report; an unreported field counts as
 * zero here, which is safe only because a turn with no usage at all never
 * reaches this function.
 */
export interface TokenUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  turns: number;
  updated_at: string;
}

/**
 * Anything not a finite, non-negative number counts as zero. A provider
 * reporting NaN for one field must not turn the whole running total into
 * NaN — the other fields, and every later turn, stay readable.
 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Float addition otherwise leaves 0.30000000000000004 in the CLI output. */
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * A row that won't parse is treated as absent rather than fatal: losing an
 * earlier total is bad, but failing the turn over an accounting row would be
 * worse. Anything other than malformed JSON still throws.
 */
function parseTotals(raw: string): Partial<TokenUsageTotals> | null {
  try {
    return JSON.parse(raw) as Partial<TokenUsageTotals> | null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export function getTokenUsage(): TokenUsageTotals | null {
  const raw = getValue(USAGE_KEY);
  if (raw === undefined) return null;
  const parsed = parseTotals(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    input_tokens: count(parsed.input_tokens),
    output_tokens: count(parsed.output_tokens),
    cache_read_tokens: count(parsed.cache_read_tokens),
    cache_creation_tokens: count(parsed.cache_creation_tokens),
    cost_usd: count(parsed.cost_usd),
    turns: count(parsed.turns),
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
  };
}

export function addTokenUsage(delta: TokenUsageDelta): void {
  const prior = getTokenUsage() ?? EMPTY_TOTALS;
  const totals: TokenUsageTotals = {
    input_tokens: prior.input_tokens + count(delta.inputTokens),
    output_tokens: prior.output_tokens + count(delta.outputTokens),
    cache_read_tokens: prior.cache_read_tokens + count(delta.cacheReadTokens),
    cache_creation_tokens: prior.cache_creation_tokens + count(delta.cacheCreationTokens),
    cost_usd: roundCost(prior.cost_usd + count(delta.costUsd)),
    // The turn counts even when its numbers were unusable — otherwise a
    // provider that reports nothing looks like a session that never ran.
    turns: prior.turns + 1,
    updated_at: new Date().toISOString(),
  };
  setValue(USAGE_KEY, JSON.stringify(totals));
}

const EMPTY_TOTALS: TokenUsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0,
  turns: 0,
  updated_at: '',
};

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(IN_REPLY_TO_KEY) as { value: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}
