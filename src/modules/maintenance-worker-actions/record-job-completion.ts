/**
 * record_job_completion -- "listo" + photo (or a plain completion report
 * with no photo). Durably copies the photo out of the session's ephemeral
 * inbox and records a job_completions row. No Trello write happens here;
 * Kirk reviews completions and closes cards himself in Phase 1.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * resolveActingWorkerUserId are now async (awaited); getDb().prepare/run
 * -> await getDb().run. copyPhotoDurably (pure fs) is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { sessionDir } from '../../session-manager.js';
import { resolveInboxAttachmentPath } from '../../attachment-safety.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID, MAINTENANCE_PHOTOS_DIR } from './config.js';
import { resolveActingWorkerUserId } from './identity.js';

interface CompletionPayload {
  job_reference: string;
  attachment_path?: string;
  source_message_id?: string;
}

function isValid(p: unknown): p is CompletionPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.job_reference !== 'string' || !row.job_reference.trim()) return false;
  if (row.attachment_path !== undefined && typeof row.attachment_path !== 'string') return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  return true;
}

export async function validateRecordJobCompletion(
  content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'record_job_completion failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.completion)) {
    await notifyAgent(session, 'record_job_completion failed: completion.job_reference is required.');
    return false;
  }
  return true;
}

function copyPhotoDurably(session: Session, completionId: string, attachmentPath: string): string | null {
  const inboxRoot = path.join(sessionDir(session.agent_group_id, session.id), 'inbox');
  const resolved = resolveInboxAttachmentPath(inboxRoot, attachmentPath);
  if (!resolved.ok) {
    log.warn('record_job_completion: could not resolve referenced attachment', {
      completionId,
      reason: resolved.reason,
    });
    return null;
  }
  const destDir = path.join(MAINTENANCE_PHOTOS_DIR, completionId);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, resolved.filename);
  fs.copyFileSync(resolved.absolutePath, dest);
  return dest;
}

export async function applyRecordJobCompletion(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('record_job_completion apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const completion = payload.completion as CompletionPayload;
  const identity = await resolveActingWorkerUserId(session, completion.source_message_id);
  if (!identity.ok || !identity.userId) {
    await notifyAgent(session, `record_job_completion failed: ${identity.reason}`);
    return;
  }
  const workerUserId = identity.userId;

  const completionId = randomUUID();
  const now = new Date().toISOString();

  let photoPath: string | null = null;
  if (completion.attachment_path) {
    photoPath = copyPhotoDurably(session, completionId, completion.attachment_path);
  }

  await getDb().run(
    `INSERT INTO job_completions (id, job_reference, worker_user_id, reported_at, photo_path, status)
     VALUES (?, ?, ?, ?, ?, 'reported')`,
    completionId,
    completion.job_reference,
    workerUserId,
    now,
    photoPath,
  );

  await notifyAgent(session, `Completion recorded for ${completion.job_reference}${photoPath ? ' with photo' : ''}.`);
  log.info('record_job_completion: applied', { completionId, workerUserId, jobReference: completion.job_reference });
}
