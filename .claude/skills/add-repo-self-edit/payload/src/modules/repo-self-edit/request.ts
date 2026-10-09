/**
 * Validation + hold-request builder for repo self-edit proposals.
 *
 * validateRepoSelfEdit runs as the delivery wrapper's precheck — on the
 * first dispatch AND again on the approved replay, so the patch is
 * re-checked against the tree as it is at apply time, not as it was when
 * the card went out. requestRepoSelfEditHold renders the card: the whole
 * patch, fenced and escaped, because the admin must see every line that
 * will land. A patch too large for one card is refused with a request to
 * split it rather than shown truncated.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { escapeInvisibles } from '../self-mod/request.js';
import { checkPatch, dirtyFiles, ignoredFiles } from './git.js';
import { parsePatchFiles, pathRefusal } from './policy.js';
import { isLocked, repoRoot } from './state.js';

/** Byte cap on the rendered card — a chat message limit leaves room for about this much. */
export const CARD_MAX_BYTES = 3500;
const MAX_REASON_CHARS = 300;

async function refuse(session: Session, why: string): Promise<false> {
  await notifyAgent(session, `repo_self_edit refused: ${why}`);
  return false;
}

export async function validateRepoSelfEdit(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const { diff, reason } = content;
  if (typeof diff !== 'string' || diff.trim() === '') return refuse(session, 'diff is required.');
  if (typeof reason !== 'string' || reason.trim() === '') return refuse(session, 'reason is required.');
  if (reason.length > MAX_REASON_CHARS) return refuse(session, `reason is longer than ${MAX_REASON_CHARS} characters.`);

  const parsed = parsePatchFiles(diff);
  if (!parsed.ok) return refuse(session, `${parsed.error}.`);
  for (const file of parsed.files) {
    const why = pathRefusal(file);
    if (why) return refuse(session, `${why}.`);
  }

  const root = repoRoot();
  const ignored = ignoredFiles(root, parsed.files);
  if (ignored.length > 0) return refuse(session, `${ignored.join(', ')} is ignored by git and cannot be edited.`);
  if (isLocked(root)) return refuse(session, 'another self-edit is still being applied — try again once it reports.');
  const dirty = dirtyFiles(root, parsed.files);
  if (dirty.length > 0) {
    return refuse(
      session,
      `${dirty.join(', ')} has uncommitted changes on the host — the operator must settle them first.`,
    );
  }
  const conflict = checkPatch(root, diff);
  if (conflict) return refuse(session, `the patch does not apply to the current tree: ${conflict.slice(0, 500)}`);
  return true;
}

export function renderCard(agentName: string, reason: string, diff: string): string {
  return (
    `Agent "${agentName}" wants to change NanoClaw's own source:\n` +
    `Reason: ${escapeInvisibles(JSON.stringify(reason))}\n` +
    '```\n' +
    diff
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => escapeInvisibles(line))
      .join('\n') +
    '\n```'
  );
}

export async function requestRepoSelfEditHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const diff = content.diff as string;
  const reason = content.reason as string;

  const question = renderCard(agentGroup.name, reason, diff);
  if (Buffer.byteLength(question, 'utf8') > CARD_MAX_BYTES) {
    await refuse(
      session,
      `the approval card would exceed ${CARD_MAX_BYTES} bytes — split the change into smaller proposals so each one can be read in full.`,
    );
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'repo_self_edit',
    payload: { diff, reason },
    title: 'Source Edit Request',
    question,
  });
}
