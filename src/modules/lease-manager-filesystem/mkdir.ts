/**
 * lease_fs_mkdir -- create a new subfolder inside the Lease Manager root.
 * Approval-gated (infrequent, structurally significant, cheap to ask).
 * Reuses resolveNewPathWithinRoot -- same "parent must exist, target must
 * not" guarantee as a move/copy destination.
 *
 * Ported from old commit 59de60dc, adapted to await getAgentGroup/
 * notifyAgent/requestApproval (now async) and the async audit.ts helpers.
 * validateLeaseFsMkdir's signature changes from `boolean` to
 * `Promise<boolean>` -- DeliveryGuardSpec.precheck already accepts either
 * shape (see src/delivery-guard.ts), matching self-mod's own precheck
 * functions.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { markFsOperationApplied, markFsOperationFailed, recordFsOperationRequested } from './audit.js';
import { LEASE_MANAGER_AGENT_GROUP_ID, LEASE_MANAGER_ROOT_WIN, LEASE_MANAGER_ROOT_WSL } from './config.js';
import { resolveNewPathWithinRoot } from './path-safety.js';

interface MkdirPayload {
  relative_path: string;
  context_note?: string;
}

function isValidPayload(p: unknown): p is MkdirPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.relative_path !== 'string' || !row.relative_path.trim()) return false;
  if (row.context_note !== undefined && typeof row.context_note !== 'string') return false;
  return true;
}

export async function validateLeaseFsMkdir(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    await notifyAgent(session, 'lease_fs_mkdir failed: not permitted for this agent.');
    log.warn('lease_fs_mkdir: rejected non-Lease-Manager caller', { agentGroupId: session.agent_group_id });
    return false;
  }
  if (!isValidPayload(content)) {
    await notifyAgent(session, 'lease_fs_mkdir failed: relative_path is required.');
    return false;
  }
  const check = resolveNewPathWithinRoot(LEASE_MANAGER_ROOT_WSL, content.relative_path);
  if (!check.ok) {
    await notifyAgent(session, `lease_fs_mkdir failed: ${check.reason}`);
    return false;
  }
  return true;
}

export async function requestLeaseFsMkdirHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const payload = content as unknown as MkdirPayload;
  const requestId = randomUUID();

  await recordFsOperationRequested({
    id: requestId,
    operationType: 'mkdir',
    sourceRelativePath: null,
    destRelativePath: payload.relative_path,
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
    `Create folder ${payload.relative_path}${contextLine}`;

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'lease_fs_mkdir',
    payload: { requestId, relative_path: payload.relative_path, context_note: payload.context_note ?? null },
    title: 'Lease Manager Create Folder',
    question,
  });
}

export async function applyLeaseFsMkdir(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    log.error('lease_fs_mkdir apply: rejected non-Lease-Manager session at apply time', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const requestId = payload.requestId as string;
  const relPath = payload.relative_path as string;

  const check = resolveNewPathWithinRoot(LEASE_MANAGER_ROOT_WSL, relPath);
  if (!check.ok) {
    await markFsOperationFailed(requestId, check.reason!);
    await notifyAgent(session, `lease_fs_mkdir failed: ${check.reason}`);
    log.warn('lease_fs_mkdir: apply-time resolution failed', { requestId, reason: check.reason });
    return;
  }

  try {
    fs.mkdirSync(check.absolutePath!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFsOperationFailed(requestId, msg);
    await notifyAgent(session, `lease_fs_mkdir failed: ${msg}`);
    log.error('lease_fs_mkdir: operation failed', { requestId, err: msg });
    return;
  }

  await markFsOperationApplied(requestId);
  await notifyAgent(session, `Created folder ${relPath}.`);
  log.info('lease_fs_mkdir: applied', { requestId, relPath });
}
