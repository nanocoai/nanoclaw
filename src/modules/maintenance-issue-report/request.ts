/**
 * Precheck for report_maintenance_issue — runs before the guard consult,
 * so it re-checks the calling agent group itself rather than relying on
 * guard.ts having already run (same discipline as
 * lease-manager-generate/request.ts).
 *
 * Ported from old commit 824318ff, adapted: notifyAgent is now async
 * (awaited); validateReportMaintenanceIssue's signature changes
 * boolean -> Promise<boolean>, matching DeliveryGuardSpec.precheck's
 * accepted shape (same pattern as lease-manager-generate/request.ts).
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';

export interface IssueReportPayload {
  property_reference: string;
  unit?: string;
  description: string;
  urgency?: 'normal' | 'urgent';
  attachment_path?: string;
  source_message_id?: string;
}

function isValidPayload(p: unknown): p is IssueReportPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.property_reference !== 'string' || !row.property_reference.trim()) return false;
  if (typeof row.description !== 'string' || !row.description.trim()) return false;
  if (row.unit !== undefined && typeof row.unit !== 'string') return false;
  if (row.urgency !== undefined && row.urgency !== 'normal' && row.urgency !== 'urgent') return false;
  if (row.attachment_path !== undefined && typeof row.attachment_path !== 'string') return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  return true;
}

export async function validateReportMaintenanceIssue(
  content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'report_maintenance_issue failed: not permitted for this agent.');
    log.warn('report_maintenance_issue: rejected non-Maintenance-Coordinator caller', {
      agentGroupId: session.agent_group_id,
    });
    return false;
  }

  if (!isValidPayload(content.report)) {
    await notifyAgent(
      session,
      'report_maintenance_issue failed: report is malformed -- check property_reference and description (both required, non-empty strings), and optional unit/urgency/photo_message_id/photo_filename.',
    );
    return false;
  }

  return true;
}
