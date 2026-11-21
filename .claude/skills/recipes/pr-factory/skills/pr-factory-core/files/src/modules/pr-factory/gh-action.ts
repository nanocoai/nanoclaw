/**
 * GH-action seam — pr-factory-core's optional credentialed-GitHub surface.
 *
 * The container's `credentialed_gh` MCP tool emits a `pr_gh` system action;
 * core registers the delivery action (so the agent always gets feedback) but
 * ships NO executor — running approved `gh` commands with operator
 * credentials is the `gh-action-approval` component, which registers its
 * handler here at import time.
 *
 * Cross-component contract: keep `GhActionHandler` / `setGhActionHandler`
 * stable — the gh-action-approval component registers against them.
 */
import { notifyAgent } from '../approvals/primitive.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export type GhActionHandler = (content: Record<string, unknown>, session: Session) => Promise<void>;

let handler: GhActionHandler | null = null;

/** Register the executor (or pass null to unregister, e.g. to pin the fallback in tests). */
export function setGhActionHandler(h: GhActionHandler | null): void {
  handler = h;
}

/** Delivery-action entry for `pr_gh`. Registered by core's index.ts. */
export async function dispatchGhAction(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!handler) {
    log.warn('pr_gh requested but the gh-action-approval component is not installed', { sessionId: session.id });
    notifyAgent(
      session,
      'credentialed_gh is unavailable: the gh-action-approval component is not installed on this host. ' +
        'Report the intended command in the thread instead.',
    );
    return;
  }
  await handler(content, session);
}
