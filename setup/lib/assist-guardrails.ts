/**
 * Guardrails shared by every setup failure assist (Claude, Codex, OpenCode).
 *
 * The assist runs on the operator's live install: the same containers,
 * service, `.env` and gateway materials the running NanoClaw depends on.
 * Each launcher adds these lines to the agent's context AND enforces what
 * its CLI can enforce (permission modes, sandbox flags, deny rules), because
 * a small or free model can ignore prose.
 */

/** The supported repair path for a broken gateway, named in the context and the debug skill. */
export const GATEWAY_REPAIR_COMMAND = 'pnpm exec tsx setup/index.ts --step gateway';

export const ASSIST_GUARDRAILS: readonly string[] = [
  "Guardrails — this is the operator's live install:",
  '- Never stop, remove or recreate containers, volumes or networks (no docker stop, rm, kill or compose down), even ones that look stale or unrelated.',
  '- Never stop or unload the NanoClaw service (launchctl unload/bootout, systemctl stop/disable). Ask before restarting it.',
  '- Ask before editing .env, gateway files or source code, and before rebuilding the image.',
  '- Never print or pass credentials: no docker inspect of container env, no proxy URLs or tokens on a command line, no reading .env or key files aloud.',
  `- If the gateway is broken, repair it only by re-running its setup step: ${GATEWAY_REPAIR_COMMAND}`,
  "- Propose repairs and explain them. Setup's retry of the failed step verifies them.",
];

export function assistGuardrails(): string {
  return ASSIST_GUARDRAILS.join('\n');
}

/**
 * Read-only diagnostics OpenCode may run without asking. Wildcard patterns
 * where `*` matches anything. `docker inspect` is deliberately absent: it
 * prints container env, which holds gateway credentials. `ncl` is absent
 * because a wildcard cannot keep a read verb from matching a mutating
 * command's arguments. The launcher re-asks for redirection and file output.
 */
export const READ_ONLY_COMMANDS: readonly string[] = [
  'docker ps *',
  'docker logs *',
  'docker images *',
  'ls *',
  'cat logs/*',
  'tail logs/*',
  'tail * logs/*',
  'grep * logs/*',
  'git status *',
  'git log *',
  'git diff *',
];

/** `<tool> <verb>` with or without options between them, e.g. `docker compose -f x.yml down`. */
function verbs(tool: string, names: string[]): string[] {
  return names.flatMap((verb) => [`${tool} ${verb} *`, `${tool} * ${verb} *`]);
}

/**
 * Commands that take down a live install. Denied outright where the CLI
 * supports deny rules (OpenCode debug sessions, Claude). A deny list is a
 * backstop, not a boundary: anything it misses still asks, or runs in a
 * sandbox, depending on the launcher.
 */
export const DESTRUCTIVE_COMMANDS: readonly string[] = [
  ...verbs('docker', ['rm', 'rmi', 'stop', 'kill', 'down', 'prune']),
  ...verbs('launchctl', ['unload', 'bootout', 'remove', 'kill', 'disable']),
  ...verbs('systemctl', ['stop', 'disable', 'kill', 'mask']),
];
