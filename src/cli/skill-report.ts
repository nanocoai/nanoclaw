/**
 * The contract between `ncl skills` and the headless skill engine
 * (`scripts/skill-headless.ts`).
 *
 * The engine is tsx-run TypeScript under `scripts/`, while the host runs the
 * compiled `dist/`, so `src/` never imports `scripts/`; the host spawns the
 * script and parses the one JSON document it prints. Scripts do import from
 * `src/`, so the constants and types both sides share live here, once.
 */
import { parse as parseYaml } from 'yaml';

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

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A markdown document's YAML frontmatter as a mapping; undefined when absent, unparseable, or not a mapping. */
export function parseFrontmatter(md: string): Record<string, unknown> | undefined {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  const close = lines.indexOf('---', 1);
  if (close === -1) return undefined;
  try {
    const parsed: unknown = parseYaml(lines.slice(1, close).join('\n'));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/** What an `nc:prompt` declares about the value it needs — the engine's own prompt semantics. */
export interface InputMeta {
  question: string; // the prompt body (verbatim)
  secret: boolean; // consumer must mask
  validate?: string; // regex source (nc:prompt validate:<re>)
  flags?: string; // regex flags   (nc:prompt flags:<f>)
  normalize?: 'trim' | 'rstrip-slash' | 'lower'; // applied by the ENGINE at bind
  // Interactive select options, `|`-separated (nc:prompt choices:a|b). When a
  // value is legal only via pre-bound inputs (e.g. slack's `provisioned`
  // connection), validate stays wider than the offered set — so a consumer
  // must prefer this over options derived from the validate alternation.
  choices?: string;
}

/** A skill's declared input, named. */
export type SkillPromptSummary = { var: string } & InputMeta;

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
