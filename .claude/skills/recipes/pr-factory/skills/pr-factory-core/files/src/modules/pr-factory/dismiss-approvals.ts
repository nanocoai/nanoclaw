/**
 * Dismiss stale approval cards for a PR session.
 *
 * Dismisses ALL pending approval cards for the session — only one
 * active card per thread at a time. If the agent needs multiple GH
 * commands, they should be combined into one or queued sequentially
 * (approve card 1 → executes → agent posts card 2).
 */
import { getPendingApprovalsBySession, deletePendingApproval } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function dismissStaleApprovals(session: Session): Promise<number> {
  const stale = getPendingApprovalsBySession(session.id);
  if (stale.length === 0) return 0;

  const adapter = getDeliveryAdapter();
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;

  for (const row of stale) {
    // Edit the card in place to show it's been dismissed. The instance arg
    // routes the edit through the same bot identity that posted the card —
    // under exact-instance dispatch an omitted instance would edit through
    // the default (worker) bot and fail on supervisor/tester cards.
    if (adapter && row.platform_message_id && mg) {
      try {
        await adapter.deliver(
          mg.channel_type,
          mg.platform_id,
          session.thread_id,
          'chat-sdk',
          JSON.stringify({
            operation: 'edit',
            messageId: row.platform_message_id,
            text: `~${row.title || 'Approval'}~ — Dismissed`,
          }),
          undefined,
          mg.instance,
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort card edit; the row delete below is the functional part
      } catch (err) {
        log.warn('Failed to edit dismissed approval card', { approvalId: row.approval_id, err });
      }
    }
    deletePendingApproval(row.approval_id);
  }

  log.info('Dismissed stale approval cards', { count: stale.length, sessionId: session.id });
  return stale.length;
}
