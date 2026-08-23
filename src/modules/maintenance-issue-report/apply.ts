/**
 * Guarded handler body for report_maintenance_issue.
 *
 * Runs on the guard's `allow` decision. Resolves which worker reported
 * this directly from the session's own messaging group (a worker's
 * private DM's platform_id *is* their identity -- the same pattern
 * approval routing already relies on for Kirk's own DM), durably copies
 * any referenced photo out of the session's ephemeral inbox (never
 * cleaned up automatically, not a safe permanent home), records the
 * report, and immediately asks Kirk what to do about it via the
 * structured maintenance_decision card -- a report alone never authorizes
 * a trip, purchase, or reprioritization.
 *
 * Ported from old commit 824318ff, adapted from sync
 * `getDb().prepare(sql).run(...)` to the current async DbDriver
 * (`await getDb().run(sql, ...)`), and `resolveActingWorkerUserId` /
 * `notifyAgent` are now async and awaited. Pure-fs `copyPhotoDurably`
 * (via ../../attachment-safety.js's resolveInboxAttachmentPath, ported
 * alongside this module) is unchanged.
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
import { resolveActingWorkerUserId } from '../maintenance-worker-actions/identity.js';
import { requestMaintenanceDecision } from '../maintenance-decisions/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID, MAINTENANCE_PHOTOS_DIR } from './config.js';
import type { IssueReportPayload } from './request.js';

/** Copies a photo out of the session's ephemeral inbox into durable storage. Returns the durable path, or null if no photo was referenced or the copy failed. */
function copyPhotoDurably(session: Session, issueId: string, attachmentPath: string): string | null {
  const inboxRoot = path.join(sessionDir(session.agent_group_id, session.id), 'inbox');
  const resolved = resolveInboxAttachmentPath(inboxRoot, attachmentPath);
  if (!resolved.ok) {
    log.warn('report_maintenance_issue: could not resolve referenced attachment', { issueId, reason: resolved.reason });
    return null;
  }
  const destDir = path.join(MAINTENANCE_PHOTOS_DIR, issueId);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, resolved.filename);
  fs.copyFileSync(resolved.absolutePath, dest);
  return dest;
}

export async function applyReportMaintenanceIssue(payload: Record<string, unknown>, session: Session): Promise<void> {
  // Re-check even though request.ts's precheck already gated this.
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('report_maintenance_issue apply: rejected non-Maintenance-Coordinator session at apply time', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const report = payload.report as IssueReportPayload;
  const identity = await resolveActingWorkerUserId(session, report.source_message_id);
  if (!identity.ok || !identity.userId) {
    await notifyAgent(session, `report_maintenance_issue failed: ${identity.reason}`);
    log.error('report_maintenance_issue: could not resolve worker identity', {
      sessionId: session.id,
      reason: identity.reason,
    });
    return;
  }
  const workerUserId = identity.userId;

  const issueId = randomUUID();
  const now = new Date().toISOString();

  let photoPath: string | null = null;
  if (report.attachment_path) {
    photoPath = copyPhotoDurably(session, issueId, report.attachment_path);
  }

  const urgency = report.urgency ?? 'normal';

  await getDb().run(
    `INSERT INTO reported_issues (id, worker_user_id, property_reference, unit, description, urgency, photo_path, reported_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    issueId,
    workerUserId,
    report.property_reference,
    report.unit ?? null,
    report.description,
    urgency,
    photoPath,
    now,
  );

  const urgentLine =
    urgency === 'urgent'
      ? 'This looks URGENT (active leak/broken pipe/safety issue) — treat it that way, not as routine.\n\n'
      : '';
  const question =
    `${urgentLine}A worker just reported a new maintenance issue.\n\n` +
    `Property: ${report.property_reference}${report.unit ? ` (unit ${report.unit})` : ''}\n` +
    `Reported: ${report.description}\n` +
    (photoPath ? 'A photo was included.\n' : '') +
    `\nThis report alone hasn't authorized anything — no trip, purchase, or reprioritization happens until you say what you want done. ` +
    `What would you like to happen with this?`;

  const result = await requestMaintenanceDecision({ issueId, question, urgent: urgency === 'urgent' });
  if (!result.ok) {
    await notifyAgent(
      session,
      `The issue was recorded, but notifying Kirk failed: ${result.reason}. Please flag this to Kirk another way.`,
    );
    log.error('report_maintenance_issue: decision card failed', { issueId, reason: result.reason });
    return;
  }

  await getDb().run("UPDATE reported_issues SET status = 'kirk_notified' WHERE id = ?", issueId);

  await notifyAgent(
    session,
    'Issue recorded and Kirk has been notified. No action beyond acknowledging it to the worker until Kirk responds.',
  );
  log.info('report_maintenance_issue: applied', { issueId, workerUserId, urgency });
}
