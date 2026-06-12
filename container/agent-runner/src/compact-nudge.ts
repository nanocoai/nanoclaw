// Early-compaction nudge: when effective context crosses a configurable ratio
// of the SDK auto-compact ceiling, push a one-shot reminder into the active
// SDK query as a synthetic user message. The reminder asks the agent to
// consider running /compact at a natural pause point, and strongly suggests
// passing an `instructions` payload so load-bearing details survive the
// compaction boundary.
//
// Why push as a user message instead of attaching as plain context: pushing
// makes the agent acknowledge and reply, which surfaces its reasoning about
// whether this is a natural pause point or it's mid-task. A silent context
// note lets the agent ignore the question entirely. PR #2327's mechanism is
// reused here deliberately — a one-shot latch + post-compact reset keep it
// from spamming the conversation.

export interface NudgeConfig {
  enabled: boolean;
  ceiling: number;
  threshold: number;
  ratio: number;
}

const DEFAULT_RATIO = 0.75;
const DEFAULT_CEILING = 165_000;

export function readNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  const ratio = parseRatio(env.COMPACT_NUDGE_RATIO);
  const ceiling = parseCeiling(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const enabled = ratio > 0 && ratio < 1 && ceiling > 0;
  return { enabled, ratio, ceiling, threshold: Math.floor(ceiling * ratio) };
}

function parseRatio(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RATIO;
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0;
}

function parseCeiling(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CEILING;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CEILING;
}

export interface UsageSample {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function effectiveContext(u: UsageSample): number {
  return (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
}

export function buildNudgeReminder(used: number, ceiling: number): string {
  const usedStr = used.toLocaleString();
  const ceilingStr = ceiling.toLocaleString();
  return [
    '<system-reminder>',
    `Context usage is now ${usedStr} tokens (auto-compact ceiling: ${ceilingStr}). `,
    'If you are at a natural pause point (between tasks, after a deliverable, not mid-edit or mid-investigation), ',
    'consider running `/compact` now — and STRONGLY PREFER passing an instructions argument so load-bearing details survive ',
    '(specific identifiers, exact phrasing, the open question, the next pending step). ',
    "Ignore if you're mid-task; this nudge is one-shot per compact cycle.",
    '</system-reminder>',
  ].join('');
}

export interface NudgeTracker {
  /**
   * Record a usage sample. Returns the reminder text to push into the active
   * query when usage first crosses the threshold in the current compact
   * cycle; returns null otherwise (under threshold, already fired, or
   * disabled).
   */
  onUsage(sample: UsageSample): string | null;
  /** Reset the latch — call when the SDK emits a `compact_boundary` event. */
  onCompactBoundary(): void;
  /** Test/inspection accessor. */
  state(): { lastEffective: number; sent: boolean };
}

export function createNudgeTracker(config: NudgeConfig = readNudgeConfig()): NudgeTracker {
  let lastEffective = 0;
  let sent = false;

  return {
    onUsage(sample) {
      if (!config.enabled) return null;
      const used = effectiveContext(sample);
      if (used > lastEffective) lastEffective = used;
      if (sent) return null;
      if (used < config.threshold) return null;
      sent = true;
      return buildNudgeReminder(used, config.ceiling);
    },
    onCompactBoundary() {
      sent = false;
      lastEffective = 0;
    },
    state() {
      return { lastEffective, sent };
    },
  };
}
