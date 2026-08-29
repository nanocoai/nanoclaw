/**
 * Converts a provider's running totals into one turn's usage.
 *
 * The Claude SDK reports tokens and cost CUMULATIVELY: every `result` message
 * carries the totals for its whole SDK session, not the delta since the last
 * one. That matters here because one `query()` outlives a single turn — the
 * poll loop pushes follow-up messages and nudge retries into an open stream,
 * and each push yields another `result`. Banking those figures as they arrive
 * charges every earlier turn again for each later one.
 *
 * Resume makes it worse: on `resume` the SDK restores the previous run's
 * totals, so the first `result` after a wake already contains everything the
 * session ever spent. Banking that re-banks the session's whole history, every
 * wake.
 *
 * So the last reading is kept and only the difference is banked. Two
 * consequences shape the design:
 *
 * - The baseline is persisted rather than held in memory, because the
 *   restore-on-resume case spans container restarts and in-memory state does
 *   not survive those.
 * - It is keyed by the SDK session id, because a reading is only comparable
 *   with an earlier reading from the same accumulator. An unfamiliar session
 *   id starts from zero, which is where that accumulator started too.
 */
import { getAgentMailbox } from '../mailbox/index.js';
import type { ProviderUsage } from '../providers/types.js';

const BASELINE_KEY = 'token_usage_baseline';

/** The fields the provider accumulates. Cost is a float; the rest are counts. */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'] as const;

interface Baseline {
  /** Which accumulator the reading came from. Null when the provider names none. */
  sessionId: string | null;
  usage: ProviderUsage;
}

/** Float subtraction otherwise leaves 0.19999999999999998 on the ledger. */
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function reported(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Only the fields the reading actually carries — an absent one must not
 *  overwrite a known baseline with `undefined`. */
function definedFields(usage: ProviderUsage): ProviderUsage {
  const out: ProviderUsage = {};
  for (const field of USAGE_FIELDS) if (reported(usage[field])) out[field] = usage[field];
  return out;
}

/**
 * One turn's usage: the cumulative reading minus the previous one.
 *
 * A field the reading does not carry stays absent rather than becoming zero —
 * "the provider didn't report it" and "it cost nothing" are different claims,
 * and only the caller knows which it can act on.
 *
 * A reading BELOW the baseline means the accumulator restarted underneath us
 * (a fresh session that reused the id, or a provider that turns out to report
 * per turn after all). The reading is then taken whole: banking a negative
 * would corrupt the running total, and treating it as zero would lose a real
 * turn.
 */
export function usageDelta(cumulative: ProviderUsage, baseline: ProviderUsage | null): ProviderUsage {
  const delta: ProviderUsage = {};
  for (const field of USAGE_FIELDS) {
    const now = cumulative[field];
    if (!reported(now)) continue;
    const before = baseline?.[field];
    const value = reported(before) && now >= before ? now - before : now;
    delta[field] = field === 'costUsd' ? roundCost(value) : value;
  }
  return delta;
}

/**
 * A stored baseline that won't parse is treated as absent rather than fatal.
 * Over-counting one turn beats failing the turn over an accounting row.
 */
function readBaseline(): Baseline | null {
  const raw = getAgentMailbox().operations.getState(BASELINE_KEY)?.value;
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { sessionId, usage } = parsed as Partial<Baseline>;
  if (!usage || typeof usage !== 'object') return null;
  return { sessionId: typeof sessionId === 'string' ? sessionId : null, usage: definedFields(usage) };
}

/**
 * Bank-ready usage for the turn that just ended, given the provider's
 * cumulative reading and the accumulator it came from.
 *
 * Returns undefined when there is nothing to bank, which the caller must treat
 * as "unreported" rather than "free".
 */
export function turnUsage(cumulative: ProviderUsage | undefined, sessionId: string | null): ProviderUsage | undefined {
  if (!cumulative) return undefined;
  const stored = readBaseline();
  const baseline = stored && stored.sessionId === sessionId ? stored.usage : null;
  const delta = usageDelta(cumulative, baseline);
  const next: Baseline = { sessionId, usage: { ...(baseline ?? {}), ...definedFields(cumulative) } };
  getAgentMailbox().operations.setState(BASELINE_KEY, JSON.stringify(next));
  return delta;
}
