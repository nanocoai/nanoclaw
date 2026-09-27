/**
 * Context for the Claude setup assists. The assist runs on the operator's
 * live install; its launch flags make it read-only, and these lines tell
 * the model why.
 */

/** The supported repair path for a broken gateway, named in the context and the debug skill. */
export const GATEWAY_REPAIR_COMMAND = 'pnpm exec tsx setup/index.ts --step gateway';

export const ASSIST_GUARDRAILS: readonly string[] = [
  "This is the operator's live install:",
  '- Propose each repair and explain it before you make it.',
  '- Never print credentials: no docker inspect of container env, no proxy URLs or tokens on a command line.',
  `- If the gateway is broken, start by re-running its setup step: ${GATEWAY_REPAIR_COMMAND}`,
];

export function assistGuardrails(): string {
  return ASSIST_GUARDRAILS.join('\n');
}
