/**
 * Return processing claims for retry without acknowledging their messages.
 * A failed acknowledgment is terminal to Host delivery, so retry must delete
 * only processing claims. SqliteAgentMailbox exposes this through the shared
 * mailbox interface; callers do not depend on the storage implementation.
 */
import { getOutboundDb } from './connection.js';

export function releaseProcessingClaims(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'processing'");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}
