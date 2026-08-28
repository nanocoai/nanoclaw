/**
 * get_key_binder_status -- read-only lookup so Maintenance Coordinator
 * can check where a key binder actually is before telling a worker to
 * drive to the office for it. Two lookup shapes: by binder name directly,
 * or by property (resolves the property's normally-assigned binder, if
 * mapped, then that binder's current custody). Never assumes "unknown"
 * or unmapped means "at the office" -- says so plainly instead.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent is now async
 * (awaited); getDb().prepare/get/all -> await getDb().get/all.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';

interface StatusPayload {
  binder?: string;
  property?: string;
}

export async function validateGetKeyBinderStatus(
  _content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'get_key_binder_status failed: not permitted for this agent.');
    return false;
  }
  return true;
}

interface BinderRow {
  id: string;
  label: string;
  home_location: string;
  holder_type: string | null;
  holder_worker_id: string | null;
  holder_note: string | null;
}

function formatBinder(b: BinderRow): string {
  const holder = b.holder_type ?? 'unknown';
  const who = holder === 'worker' ? b.holder_worker_id : holder === 'other' ? b.holder_note || '(unspecified)' : holder;
  return `${b.label}: currently with ${who ?? 'unknown'}${holder === 'unknown' ? ' -- not its home location by default, actually unreported' : ''} (home: ${b.home_location}).`;
}

const ALL_BINDERS_QUERY = `
  SELECT kb.id, kb.label, kb.home_location, ks.holder_type, ks.holder_worker_id, ks.holder_note
  FROM key_binders kb LEFT JOIN key_binder_state ks ON ks.binder_id = kb.id`;

export async function applyGetKeyBinderStatus(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('get_key_binder_status apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const info = payload.info as StatusPayload;
  const db = getDb();

  if (info.property) {
    const prop = await db.get<{ id: string }>(
      `SELECT p.id FROM properties p WHERE lower(p.address) = lower(?) OR lower(p.canonical_name) = lower(?)`,
      info.property,
      info.property,
    );
    if (!prop) {
      await notifyAgent(session, `get_key_binder_status: no known property matches "${info.property}".`);
      return;
    }
    const mapping = await db.get<{ key_binder_id: string | null; access_source_note: string | null }>(
      `SELECT key_binder_id, access_source_note FROM property_operational_info WHERE property_id = ?`,
      prop.id,
    );
    if (!mapping || (!mapping.key_binder_id && !mapping.access_source_note)) {
      await notifyAgent(
        session,
        `get_key_binder_status: no key binder or access source is mapped yet for "${info.property}" -- ask rather than assume.`,
      );
      return;
    }
    if (!mapping.key_binder_id) {
      await notifyAgent(
        session,
        `get_key_binder_status: "${info.property}" uses a non-binder access source: ${mapping.access_source_note}.`,
      );
      return;
    }
    const binder = await db.get<BinderRow>(`${ALL_BINDERS_QUERY} WHERE kb.id = ?`, mapping.key_binder_id);
    await notifyAgent(session, binder ? formatBinder(binder) : 'get_key_binder_status: mapped binder no longer exists.');
    return;
  }

  if (info.binder) {
    const binder = await db.get<BinderRow>(`${ALL_BINDERS_QUERY} WHERE lower(kb.label) = lower(?)`, info.binder);
    if (!binder) {
      await notifyAgent(session, `get_key_binder_status: no known binder matches "${info.binder}".`);
      return;
    }
    await notifyAgent(session, formatBinder(binder));
    return;
  }

  const all = await db.all<BinderRow>(ALL_BINDERS_QUERY);
  await notifyAgent(session, all.map(formatBinder).join('\n'));
}
