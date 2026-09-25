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
 * Read-only diagnostics an assist may run without asking. Wildcard patterns
 * where `*` matches anything; OpenCode and Claude both accept this form.
 * `docker inspect` is deliberately absent: it prints container env, which
 * holds gateway credentials.
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
  'ncl * list *',
  'ncl * get *',
  'git status *',
  'git log *',
  'git diff *',
];

/** Commands that take down a live install. Denied outright where the CLI supports deny rules. */
export const DESTRUCTIVE_COMMANDS: readonly string[] = [
  'docker stop *',
  'docker rm *',
  'docker kill *',
  'docker container stop *',
  'docker container rm *',
  'docker container kill *',
  'docker container prune *',
  'docker compose down *',
  'docker network rm *',
  'docker network prune *',
  'docker volume rm *',
  'docker volume prune *',
  'docker system prune *',
  'launchctl unload *',
  'launchctl bootout *',
  'launchctl remove *',
  'systemctl stop *',
  'systemctl disable *',
  'systemctl --user stop *',
  'systemctl --user disable *',
];
