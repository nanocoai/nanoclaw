/**
 * FORK CARRY: release 'processing' claims so the rows become fetchable again —
 * the contract-correct "give it back for retry" the code runner needs at a
 * life boundary. Deliberately NOT markMessages(ids, 'failed'): the host's
 * syncProcessingAcks maps a container 'failed' ack through its complete
 * statement to a TERMINAL messages_in 'completed' — a 'failed' ack silently
 * drops mail instead of retrying it.
 *
 * This is the SQLite *implementation*. The operation itself GRADUATED to
 * MailboxOperations when code mode met a non-SQLite mailbox (a recipe carrying
 * add-s3-mailbox), which is the coordination the earlier note here reserved.
 * The SQL stays in the driver because the registry tripwire keeps it here;
 * `sqlite/index.ts` binds this function as the class's interface method and
 * the runner's DB barrel resolves through the registered mailbox instead.
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
