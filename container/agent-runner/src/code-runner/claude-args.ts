/** Claude Code permission posture. Prompt by default; bypass requires an operator choice. */
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
 * A reap stops being amnesia. The workspace — and with it the CLI's own
 * session state under ~/.claude — survives on the durable volume, so a
 * respawned container passes `--continue` and the CLI resumes the most recent
 * conversation in cwd. The caller gates on hasResumableSession
 * (claude-state.ts): a fresh workspace has nothing to continue and boots
 * with exactly the argv it always did.
 */
export function resumeArgs(resumable: boolean): string[] {
  return resumable ? ['--continue'] : [];
}
