/**
 * Seed Claude Code's first-run state for the Host-provided workspace.
 * The container's home is disposable, while the workspace is durable. Without
 * this state, a fresh container can stop at a trust prompt before processing
 * messages. Preserve unrelated settings and the Host's permission policy.
 */
import fs from 'fs';
import path from 'path';

export function claudeStatePath(): string {
  return path.join(process.env.HOME || '/home/node', '.claude.json');
}

/**
 * Whether the CLI has a conversation to `--continue` in `workspaceDir`.
 *
 * The CLI keeps per-project session transcripts under
 * `~/.claude/projects/<munged cwd>/<session>.jsonl`, where the munge replaces
 * every non-alphanumeric character with '-' — the runner's fixed cwd
 * `/workspace/group` becomes `-workspace-group` under any variant of that
 * rule, which is the only path this ever asks about. `~/.claude` is the
 * group's durable provider-state mount, so the store outlives the container —
 * which is exactly what makes a post-reap `--continue` land. Absence and
 * unreadability both answer false: the fresh-boot end, never a stall.
 */
export function hasResumableSession(workspaceDir: string, home: string = process.env.HOME || '/home/node'): boolean {
  const munged = workspaceDir.replace(/[^A-Za-z0-9]/g, '-');
  try {
    return fs.readdirSync(path.join(home, '.claude', 'projects', munged)).some((name) => name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

type ProjectState = Record<string, unknown> & { hasTrustDialogAccepted?: boolean };
type ClaudeState = Record<string, unknown> & {
  hasCompletedOnboarding?: boolean;
  bypassPermissionsModeAccepted?: boolean;
  projects?: Record<string, ProjectState>;
};

/**
 * True when the state was written. A corrupt file is left ALONE and reported:
 * overwriting would eat whatever produced it, and the CLI recreates its own.
 */
export function ensureClaudeState(
  workspaceDir: string,
  /**
   * True when the deployment chose the 'bypass' posture. The CLI asks the
   * operator to accept that mode once; configuring it IS that acceptance,
   * and the sandbox has no one to ask. Left false, the key is never written
   * — an 'auto' deployment keeps the dialog it expects.
   */
  acceptBypass = false,
  statePath: string = claudeStatePath(),
): boolean {
  let state: ClaudeState = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ClaudeState;
    } catch (error) {
      console.error(`[code-runner] ${statePath} is not valid JSON — leaving it alone:`, error);
      return false;
    }
  }

  state.hasCompletedOnboarding = true;
  if (acceptBypass) state.bypassPermissionsModeAccepted = true;
  const projects: Record<string, ProjectState> = { ...(state.projects ?? {}) };
  projects[workspaceDir] = { ...(projects[workspaceDir] ?? {}), hasTrustDialogAccepted: true };
  state.projects = projects;

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
    return true;
  } catch (error) {
    console.error('[code-runner] could not seed the CLI state — expect a first-run prompt:', error);
    return false;
  }
}
