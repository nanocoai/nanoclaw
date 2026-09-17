/**
 * Guarded handler body for the bureaucracy_submit action.
 *
 * Unlike self-mod, approval here does not mutate any config or rebuild
 * anything — it only tells the agent it may proceed with the
 * agent-browser confirm step it is already waiting on.
 */
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

export async function applyBureaucracySubmit(payload: Record<string, unknown>, session: Session): Promise<void> {
  const actionId = payload.actionId as string;
  await notifyAgent(session, `Approved. Run: agent-browser confirm ${actionId}`);
}
