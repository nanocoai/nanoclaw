/**
 * Guarded handler body for repo_self_edit — runs only on an approved replay.
 *
 * Applies the approved patch and commits exactly its files, then gates on
 * the side it touched:
 *   - container/ → agent-runner typecheck in-process; on failure the commit
 *     is reverted, on success the group's containers restart onto the new
 *     source (it is a live mount, so nothing needs rebuilding).
 *   - src/ → the host cannot restart itself and watch the result, so the
 *     detached watchdog (scripts/repo-self-edit-watchdog.sh) builds,
 *     restarts, waits for a healthy host and reverts on any failure. Its
 *     verdict is reported from the next boot (./index.ts).
 *   - docs/ only → committed, nothing restarts.
 *
 * Every commit, revert included, re-stamps the upgrade marker: the startup
 * tripwire refuses to boot on a commit no sanctioned path recorded.
 */
import { restartAgentGroupContainers } from '../../container-restart.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { writeUpgradeState } from '../../upgrade-state.js';
import { notifyAgent } from '../approvals/index.js';
import { runContainerCheck, spawnWatchdog } from './checks.js';
import { applyAndCommit, revert } from './git.js';
import { editScope, parsePatchFiles } from './policy.js';
import { repoRoot, takeLock } from './state.js';

async function rollBack(root: string, session: Session, sha: string, why: string): Promise<void> {
  const undone = revert(root, sha);
  if (!undone.ok) {
    log.error('Repo self-edit revert failed', { sha, err: undone.error });
    await notifyAgent(
      session,
      `repo_self_edit: ${why}, and reverting ${sha} also failed (${undone.error}). The checkout needs a human — tell the user now.`,
    );
    return;
  }
  writeUpgradeState({ via: 'repo-self-edit-revert', projectRoot: root });
  log.warn('Repo self-edit reverted', { sha, revertSha: undone.sha });
  await notifyAgent(session, `repo_self_edit: ${why} — reverted ${sha} with ${undone.sha}. Nothing changed.`);
}

export async function applyRepoSelfEdit(payload: Record<string, unknown>, session: Session): Promise<void> {
  const root = repoRoot();
  const diff = payload.diff as string;
  const reason = payload.reason as string;
  const parsed = parsePatchFiles(diff);
  if (!parsed.ok) return; // the precheck already answered the requester
  const files = parsed.files;

  const commit = applyAndCommit(
    root,
    diff,
    files,
    `self-edit: ${reason}\n\nProposed by agent group ${session.agent_group_id}, approved by an admin.`,
  );
  if (!commit.ok) {
    await notifyAgent(session, `repo_self_edit: ${commit.error}`);
    return;
  }
  writeUpgradeState({ via: 'repo-self-edit', projectRoot: root });
  log.info('Repo self-edit committed', { agentGroupId: session.agent_group_id, sha: commit.sha, files });

  const scope = editScope(files);
  if (scope.container) {
    const check = await runContainerCheck(root);
    if (!check.ok) {
      await rollBack(root, session, commit.sha, `the agent-runner typecheck failed (${check.output.slice(0, 800)})`);
      return;
    }
  }

  if (scope.host) {
    takeLock(root, commit.sha);
    await notifyAgent(
      session,
      `repo_self_edit: committed ${commit.sha}. The host now rebuilds and restarts; this container restarts with it. ` +
        'The outcome arrives as a message once the host is back — if the build or the restart fails, the commit is reverted.',
    );
    spawnWatchdog(root, commit.sha, session.id);
    return;
  }

  if (scope.container) {
    await restartAgentGroupContainers(
      session.agent_group_id,
      'repo self-edit applied',
      `Your source edit landed as ${commit.sha} (${reason}). Verify it behaves as intended and report the result to the user.`,
    );
    return;
  }

  await notifyAgent(session, `repo_self_edit: committed ${commit.sha}. Docs only — nothing needed a restart.`);
}
