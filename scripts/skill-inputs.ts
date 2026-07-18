// inputsFromEnv — the pipeline consumer's input path (docs/skill-engine-seam.md §6).
//
// A CI/pipeline caller supplies prompt answers as environment variables using
// the `NC_INPUT_<VAR>` convention (prompt var uppercased). This helper parses
// the skill's prompt vars via parseDirectives and returns the `inputs` record
// applySkill consumes. It is a helper, not an engine feature — the engine never
// reads process.env for inputs; `inputs` stays the only env-agnostic seam.
//
// Var names are case-sensitive in the grammar, so uppercasing can collide
// (`bot_token` vs `Bot_Token` both map to NC_INPUT_BOT_TOKEN); a collision is
// an error, never a silent last-writer-wins.

import { parseDirectives, promptVar } from './skill-directives.js';

export function inputsFromEnv(md: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const inputs: Record<string, string> = {};
  const byKey = new Map<string, string>(); // NC_INPUT_<VAR> → the prompt var that claimed it
  for (const d of parseDirectives(md)) {
    if (d.kind !== 'prompt') continue;
    const v = promptVar(d);
    if (!v) continue;
    const key = `NC_INPUT_${v.toUpperCase()}`;
    const prior = byKey.get(key);
    if (prior !== undefined && prior !== v) {
      throw new Error(`inputsFromEnv: prompt vars "${prior}" and "${v}" both map to ${key} — rename one (var names must be case-insensitively unique)`);
    }
    byKey.set(key, v);
    const val = env[key];
    if (val !== undefined) inputs[v] = val;
  }
  return inputs;
}
