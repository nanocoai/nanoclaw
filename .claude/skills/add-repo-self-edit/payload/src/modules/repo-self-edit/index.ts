/**
 * Repo self-edit module — admin-approved edits to NanoClaw's own source.
 *
 * The agent proposes a git-format patch (propose_repo_edit MCP tool). The
 * delivery registry wraps the action with the guard (./guard.ts: held for
 * the admin chain, denied for agent groups not opted in); ./request.ts
 * validates the patch and renders the whole of it on the card; on approve
 * the continuation re-enters the wrapped action, the precheck re-runs
 * against the current tree, and ./apply.ts commits, gates and restarts —
 * reverting on failure.
 *
 * On host start: report the verdict the watchdog leaves for an edit that
 * needed a host restart, then release the in-flight lock.
 */
import { getSession } from '../../db/sessions.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyRepoSelfEdit } from './apply.js';
import { repoSelfEditApply } from './guard.js';
import { requestRepoSelfEditHold, validateRepoSelfEdit } from './request.js';
import { isLocked, releaseLock, repoRoot, takeResult } from './state.js';

registerDeliveryAction('repo_self_edit', applyRepoSelfEdit, {
  guardAction: repoSelfEditApply,
  precheck: validateRepoSelfEdit,
  requestHold: requestRepoSelfEditHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `repo_self_edit denied: ${reason}`),
});

registerApprovalHandler('repo_self_edit', reenterGuardedDeliveryAction('repo_self_edit'));

export async function reportWatchdogResult(root: string = repoRoot()): Promise<void> {
  const result = takeResult(root);
  if (!result) return;
  releaseLock(root);
  const text = result.ok
    ? `repo_self_edit: ${result.newSha} is live — the host rebuilt and came back healthy.`
    : result.revertSha
      ? `repo_self_edit: ${result.newSha} was reverted with ${result.revertSha} (${result.detail.slice(0, 800)}).`
      : `repo_self_edit: ${result.newSha} failed and could not be reverted (${result.detail.slice(0, 800)}). The checkout needs a human — tell the user now.`;
  log.info('Repo self-edit watchdog result', { ok: result.ok, sha: result.newSha, revertSha: result.revertSha });
  const session = result.sessionId ? await getSession(result.sessionId) : undefined;
  if (session) await notifyAgent(session, text);
}

const RESULT_POLL_MS = 5000;

async function reportSafely(root: string): Promise<void> {
  // A report that cannot be delivered must never take the host down.
  try {
    await reportWatchdogResult(root);
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort notification
  } catch (err) {
    log.warn('Failed to report repo self-edit result', { err });
  }
}

// The watchdog restarts the host before it has a verdict, so the marker
// usually lands after this boot: poll while the in-flight lock is held.
onHostStart(async ({ signal }) => {
  const root = repoRoot();
  await reportSafely(root);
  if (!isLocked(root)) return;
  const timer = setInterval(() => {
    if (!isLocked(root)) clearInterval(timer);
    else void reportSafely(root);
  }, RESULT_POLL_MS);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer));
});
