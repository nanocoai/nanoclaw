/**
 * Shared move/copy logic -- move is just copy-verify-then-delete-source,
 * so both actions share this one implementation, parameterized by kind.
 * Rename is not a separate action: it's a move within the same folder,
 * using this same primitive.
 *
 * Precheck (validateWriteOp) and apply (applyWriteOp) each independently
 * call path-safety's resolvers -- apply never trusts precheck's result
 * transitively, same discipline as every other guarded handler in this
 * codebase, because the filesystem can change between card-creation and
 * approval (e.g. someone else's operation fills the destination first).
 *
 * Ported from old commit 59de60dc, adapted to await getAgentGroup/
 * notifyAgent/requestApproval (now async) and the async audit.ts helpers.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { markFsOperationApplied, markFsOperationFailed, recordFsOperationRequested } from './audit.js';
import { LEASE_MANAGER_AGENT_GROUP_ID, LEASE_MANAGER_ROOT_WIN, LEASE_MANAGER_ROOT_WSL } from './config.js';
import { resolveExistingPathWithinRoot, resolveNewPathWithinRoot } from './path-safety.js';

export type WriteOpKind = 'move' | 'copy';

interface WriteOpPayload {
  source_relative_path: string;
  dest_relative_path: string;
  context_note?: string;
}

function isValidPayload(p: unknown): p is WriteOpPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.source_relative_path !== 'string' || !row.source_relative_path.trim()) return false;
  if (typeof row.dest_relative_path !== 'string' || !row.dest_relative_path.trim()) return false;
  if (row.context_note !== undefined && typeof row.context_note !== 'string') return false;
  return true;
}

const ACTION_NAME: Record<WriteOpKind, string> = { move: 'lease_fs_move', copy: 'lease_fs_copy' };
const VERB: Record<WriteOpKind, string> = { move: 'Move', copy: 'Copy' };
const PAST_TENSE: Record<WriteOpKind, string> = { move: 'Moved', copy: 'Copied' };

export async function validateWriteOp(kind: WriteOpKind, content: Record<string, unknown>, session: Session): Promise<boolean> {
  const action = ACTION_NAME[kind];
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    await notifyAgent(session, `${action} failed: not permitted for this agent.`);
    log.warn(`${action}: rejected non-Lease-Manager caller`, { agentGroupId: session.agent_group_id });
    return false;
  }
  if (!isValidPayload(content)) {
    await notifyAgent(
      session,
      `${action} failed: source_relative_path and dest_relative_path are required non-empty strings.`,
    );
    return false;
  }
  // Fail fast on an obviously bad path before ever creating an audit row or a card.
  const srcCheck = resolveExistingPathWithinRoot(LEASE_MANAGER_ROOT_WSL, content.source_relative_path);
  if (!srcCheck.ok) {
    await notifyAgent(session, `${action} failed: ${srcCheck.reason}`);
    return false;
  }
  const destCheck = resolveNewPathWithinRoot(LEASE_MANAGER_ROOT_WSL, content.dest_relative_path);
  if (!destCheck.ok) {
    await notifyAgent(session, `${action} failed: ${destCheck.reason}`);
    return false;
  }
  return true;
}

export async function requestWriteOpHold(
  kind: WriteOpKind,
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return; // precheck already answered the requester

  const payload = content as unknown as WriteOpPayload;
  const requestId = randomUUID();

  await recordFsOperationRequested({
    id: requestId,
    operationType: kind,
    sourceRelativePath: payload.source_relative_path,
    destRelativePath: payload.dest_relative_path,
    contextNote: payload.context_note ?? null,
    requestedByAgentGroupId: session.agent_group_id,
    requestedBySessionId: session.id,
    relatedIntakeId: null,
  });

  const contextLine = payload.context_note
    ? `\n\nContext (from Lease Manager, not independently verified): ${payload.context_note}`
    : '';
  const question =
    `LEASE MANAGER ROOT (host-configured, not agent-supplied): ${LEASE_MANAGER_ROOT_WIN}\n\n` +
    `${VERB[kind]} ${payload.source_relative_path} to ${payload.dest_relative_path}${contextLine}`;

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: ACTION_NAME[kind],
    payload: {
      requestId,
      source_relative_path: payload.source_relative_path,
      dest_relative_path: payload.dest_relative_path,
      context_note: payload.context_note ?? null,
    },
    title: kind === 'move' ? 'Lease Manager File Move' : 'Lease Manager File Copy',
    question,
  });
}

export async function applyWriteOp(
  kind: WriteOpKind,
  payload: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const action = ACTION_NAME[kind];
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    log.error(`${action} apply: rejected non-Lease-Manager session at apply time`, {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const requestId = payload.requestId as string;
  const sourceRel = payload.source_relative_path as string;
  const destRel = payload.dest_relative_path as string;

  const srcCheck = resolveExistingPathWithinRoot(LEASE_MANAGER_ROOT_WSL, sourceRel);
  if (!srcCheck.ok) {
    await markFsOperationFailed(requestId, srcCheck.reason!);
    await notifyAgent(session, `${action} failed: ${srcCheck.reason}`);
    log.warn(`${action}: apply-time source resolution failed`, { requestId, reason: srcCheck.reason });
    return;
  }
  const destCheck = resolveNewPathWithinRoot(LEASE_MANAGER_ROOT_WSL, destRel);
  if (!destCheck.ok) {
    await markFsOperationFailed(requestId, destCheck.reason!);
    await notifyAgent(session, `${action} failed: ${destCheck.reason}`);
    log.warn(`${action}: apply-time destination resolution failed`, { requestId, reason: destCheck.reason });
    return;
  }

  try {
    fs.copyFileSync(srcCheck.absolutePath!, destCheck.absolutePath!);
    const srcSize = fs.statSync(srcCheck.absolutePath!).size;
    const destSize = fs.statSync(destCheck.absolutePath!).size;
    if (destSize !== srcSize) {
      throw new Error(
        `copy verification failed (source ${srcSize} bytes, destination ${destSize} bytes) -- source left untouched.`,
      );
    }
    if (kind === 'move') {
      fs.unlinkSync(srcCheck.absolutePath!);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFsOperationFailed(requestId, msg);
    await notifyAgent(session, `${action} failed: ${msg}`);
    log.error(`${action}: operation failed`, { requestId, err: msg });
    return;
  }

  await markFsOperationApplied(requestId);
  await notifyAgent(session, `${PAST_TENSE[kind]} ${sourceRel} to ${destRel}.`);
  log.info(`${action}: applied`, { requestId, sourceRel, destRel });
}
