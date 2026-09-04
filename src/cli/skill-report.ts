/**
 * The contract between `ncl skills` and the headless skill engine
 * (`scripts/skill-headless.ts`).
 *
 * The engine is tsx-run TypeScript under `scripts/`, while the host runs the
 * compiled `dist/`, so `src/` never imports `scripts/`; the host spawns the
 * script and parses the one JSON document it prints. Scripts do import from
 * `src/`, so the constants and types both sides share live here, once.
 */

export const SKILL_APPLY_SCHEMA = 'nanoclaw-skill-apply/v1';

/**
 * Run effects the engine leaves to whoever drives it — a live service
 * restart, an interactive step, a wiring call — and, for the same reason, the
 * effects the engine's run-health gate refuses to fire after an earlier step
 * failed. One list, both meanings: each needs a live host, a human, or `ncl`.
 */
export const CALLER_OWNED_EFFECTS: readonly string[] = ['restart', 'step', 'wire'];

/** A skill directory name: lowercase, digits, hyphens — nothing that could leave `.claude/skills/`. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name "${name}" — lowercase letters, digits, and hyphens only`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type SkillKind = 'channel' | 'provider' | 'other';

export interface SkillSummary {
  name: string;
  description: string;
  kind: SkillKind;
  /** The skill's registration is present in the relevant barrel(s). */
  installed: boolean;
  prompts: number;
  secretPrompts: number;
  /** The caller-owned effects the skill declares (`restart`, `step`, `wire`) — reported back by an apply, never run by it. */
  callerOwnedEffects: string[];
}

/** A skill's declared input, as the engine's own prompt semantics describe it. */
export interface SkillPromptSummary {
  var: string;
  question: string;
  secret: boolean;
  validate?: string;
  flags?: string;
  normalize?: string;
  choices?: string;
}

export interface SkillPlan {
  skill: string;
  steps: Array<{ n: number; kind: string; line: number; status: string; detail: string }>;
  prompts: SkillPromptSummary[];
  needsInput: string[];
  agentSteps: number;
  callerOwnedEffects: string[];
}

/** A caller-owned run the engine skipped, for the caller to perform. */
export interface PendingEffect {
  effect: string;
  line: number;
  command: string;
}

export interface SkillApplyReport {
  schema: typeof SKILL_APPLY_SCHEMA;
  skill: string;
  /** `applied` = fully applied; `rolled-back` = a step failed and the journal was undone; `failed` = refused, or left partial on request. */
  status: 'applied' | 'rolled-back' | 'failed';
  applied: string[];
  skipped: string[];
  deferred: string[];
  agentTasks: Array<{ kind: string; line: number; reason: string }>;
  operatorMessages: string[];
  /** Non-secret resolved values (prompt answers, captures). */
  vars: Record<string, string>;
  pendingEffects: PendingEffect[];
  failure?: { headline: string; hint: string };
  error?: string;
}

export const needsRestart = (report: Pick<SkillApplyReport, 'pendingEffects'>): boolean =>
  report.pendingEffects.some((p) => p.effect === 'restart');
