import { getAgentGroup } from './db/agent-groups.js';
import type { LogRow } from './db/messaging-group-messages.js';

/**
 * Format a context block from the per-messaging-group message log for
 * prepending to a triggering message's text.
 *
 * Labels:
 *   - direction='in'  → `[<sender_name>, HH:MM]: <text>` (fallback "unknown")
 *   - direction='out' and agent_group_id === callerAgentId → `[bot, HH:MM]: …`
 *   - direction='out' and agent_group_id !== callerAgentId → `[bot:<name>, HH:MM]: …`
 *     so multi-agent group chats stay disambiguated.
 *
 * Rows with no text but with attachments render as `[image/file]`.
 * Rows with no text and no attachments are skipped (corner case).
 * Times are UTC HH:MM (no per-user TZ — the agent runner is TZ-agnostic).
 */
export function formatContextBlock(rows: LogRow[], callerAgentId: string): string {
  if (rows.length === 0) return '';

  const lines: string[] = [];
  for (const row of rows) {
    const label = renderLabel(row, callerAgentId);
    const body = renderBody(row);
    if (body === null) continue;
    lines.push(`[${label}, ${hhmm(row.ts)}]: ${body}`);
  }
  if (lines.length === 0) return '';

  return [`[Context — last ${lines.length} messages]`, ...lines, '[End context]'].join('\n');
}

function renderLabel(row: LogRow, callerAgentId: string): string {
  if (row.direction === 'out') {
    if (row.agent_group_id === callerAgentId) return 'bot';
    if (row.agent_group_id) {
      const ag = getAgentGroup(row.agent_group_id);
      return ag?.name ? `bot:${ag.name}` : 'bot:other';
    }
    return 'bot';
  }
  return row.sender_name?.trim() || 'unknown';
}

function renderBody(row: LogRow): string | null {
  if (row.text && row.text.length > 0) return row.text;
  if (row.has_attachments) return '[image/file]';
  return null;
}

function hhmm(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '??:??';
    const hh = d.getUTCHours().toString().padStart(2, '0');
    const mm = d.getUTCMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '??:??';
  }
}
