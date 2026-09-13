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
 * The conversation flag for one child life. A reap stops being amnesia: the
 * CLI's session store rides the group's durable `~/.claude` mount, so a life
 * whose conversation already has a transcript there resumes it BY ID; the
 * first life of a conversation starts it under that same id. The caller
 * (index.ts) resolves the id once per session and asks hasTranscript
 * (claude-state.ts) before every life, respawns included.
 */
export function conversationArgs(conversationId: string, resumable: boolean): string[] {
  return resumable ? ['--resume', conversationId] : ['--session-id', conversationId];
}
