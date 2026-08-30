/**
 * Argv for the interactive CLI (sandbox-spec D17).
 *
 * Two postures, because the enforcement point differs by deployment:
 *
 *   'bypass' — the CLI's local permission prompts are OFF. For a GOVERNED
 *     deployment this is the honest setting, not a shortcut: every request
 *     the agent makes is already classified, policy-decided and
 *     credential-injected at the gateway, so a second local y/n asks in the
 *     one place with no approver. Measured live on the POC: an agent asked
 *     over Slack to claim an env composed the right command, then waited
 *     forever on a prompt nobody could answer — reporting `busy`, so not
 *     even the D14 lease could reap it.
 *
 *   'auto' — the CLI's own prompting stands. Right where nothing else
 *     enforces (OSS single-operator, a docker driver with no gateway): an
 *     attached human answers, and D17's detached path is T7's approvals
 *     primitive.
 *
 * The mode is per group (container.json `permissionMode`), defaulting to
 * 'auto' — the safe end. A deployment whose gateway does the enforcing opts
 * into 'bypass' deliberately.
 */
export type PermissionMode = 'auto' | 'bypass';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** Anything unrecognized reads as the safe end rather than throwing at spawn. */
export function resolvePermissionMode(raw: unknown): PermissionMode {
  return raw === 'bypass' ? 'bypass' : DEFAULT_PERMISSION_MODE;
}

export function claudeArgs(model?: string | null, mode: PermissionMode = DEFAULT_PERMISSION_MODE): string[] {
  const args: string[] = [];
  if (mode === 'bypass') args.push('--dangerously-skip-permissions');
  if (model) args.push('--model', model);
  return args;
}

/**
 * C13: a reap stops being amnesia. The workspace — and with it the CLI's own
 * session state under ~/.claude — survives on the durable volume, so a
 * respawned pod passes `--continue` and the CLI resumes the most recent
 * conversation in cwd. The caller gates on hasResumableSession
 * (claude-state.ts): a fresh workspace has nothing to continue and boots
 * with exactly the argv it always did.
 */
export function resumeArgs(resumable: boolean): string[] {
  return resumable ? ['--continue'] : [];
}
