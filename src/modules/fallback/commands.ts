/**
 * `/fallback` chat command interceptor — owner/admin only, handled entirely
 * host-side so it works even when Claude (the native provider) is dead.
 * Called from router.ts's deliverToAgent, right before the existing command
 * gate. Returning true means "handled" — the caller must not write an
 * inbound row for this message.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deliverSessionMessages } from '../../delivery.js';
import { log } from '../../log.js';
import { writeOutboundDirect } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { enterFallback, exitFallback } from './controller.js';
import { getFallbackState } from './db.js';
import { commandDeniedNotice, statusNotice } from './notices.js';

export interface DeliveryAddress {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

type FallbackSubcommand = 'status' | 'force' | 'return';

function parseFallbackCommand(text: string): FallbackSubcommand | null {
  const parts = text.trim().split(/\s+/);
  if ((parts[0] ?? '').toLowerCase() !== '/fallback') return null;
  const sub = (parts[1] ?? 'status').toLowerCase();
  if (sub === 'force') return 'force';
  if (sub === 'return') return 'return';
  // 'status', no argument, or any unrecognized argument all fall
  // back to status — always "handled" so a typo doesn't leak to the agent.
  return 'status';
}

/** Same query as command-gate.ts's isAdmin — owner or admin, global or scoped to this agent group. */
function isOwnerOrAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  const db = getDb();
  if (!hasTable(db, 'user_roles')) return false; // safety: deny all when permissions module missing
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}

async function reply(session: Session, deliveryAddr: DeliveryAddress, text: string): Promise<void> {
  writeOutboundDirect(session.agent_group_id, session.id, {
    id: `fallback-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: JSON.stringify({ text }),
  });
  // Push immediately — this is a host-composed reply that doesn't need the
  // container, but the 1s "active" delivery poll only covers sessions whose
  // container is currently running/idle. Without this, a command sent while
  // the container is stopped would sit until the 60s sweep poll instead.
  try {
    await deliverSessionMessages(session);
  } catch (err) {
    log.warn('Failed to push immediate delivery for fallback command reply', { sessionId: session.id, err });
  }
}

export async function interceptFallbackCommand(
  rawContent: string,
  userId: string | null,
  session: Session,
  deliveryAddr: DeliveryAddress,
): Promise<boolean> {
  let text: string;
  try {
    const parsed = JSON.parse(rawContent);
    text = typeof (parsed as { text?: unknown }).text === 'string' ? (parsed as { text: string }).text.trim() : '';
  } catch {
    text = rawContent.trim();
  }

  const sub = parseFallbackCommand(text);
  if (sub === null) return false;

  if (!isOwnerOrAdmin(userId, session.agent_group_id)) {
    await reply(session, deliveryAddr, commandDeniedNotice());
    log.info('Fallback command denied', { userId, agentGroupId: session.agent_group_id, sub });
    return true;
  }

  log.info('Fallback command received', { userId, agentGroupId: session.agent_group_id, sub });

  switch (sub) {
    case 'status':
      await reply(session, deliveryAddr, statusNotice(getFallbackState()));
      break;
    case 'force':
      await enterFallback({
        mode: 'forced',
        classification: 'manual',
        reason: 'manual /fallback force',
        resetAt: null,
        originSessionId: session.id,
        originGroupId: session.agent_group_id,
        messageIds: [],
      });
      break;
    case 'return': {
      // Guard against a no-op restart-storm: exitFallback restarts every
      // active agent group's container, which is only meaningful work if the
      // install was actually running on the backup. If it wasn't, statusNotice
      // already says so — no reason to disrupt every live session.
      if (!getFallbackState().active) {
        await reply(session, deliveryAddr, statusNotice(getFallbackState()));
        break;
      }
      exitFallback({ via: 'manual' });
      break;
    }
  }

  return true;
}
