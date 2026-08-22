/**
 * Controlled document-delivery module — lets Pepper send Kirk a copy of a
 * Lease Manager-generated, host-verified draft PDF over his existing
 * Telegram conversation, without ever giving Pepper filesystem access.
 *
 * On install the module registers one guard-wrapped delivery action,
 * `lease_document_deliver`: the agent-group + document-resolution checks run
 * as the wrapper's precheck (./request.ts), the guard (./guard.ts) allows
 * only Pepper's own agent group and denies everyone else (no hold — the
 * underlying generation was already admin-approved), and the handler body
 * (./apply.ts) re-resolves the reference independently, confirms the
 * destination is exactly Kirk's trusted Telegram conversation, reads the
 * file host-side, and delivers it through the same channel-adapter path
 * normal outbound messages use.
 *
 * ./registry.ts's `registerGeneratedDocument` is the other half: called by
 * lease-manager-generate/apply.ts right after its own independent
 * verification passes, so a document only ever becomes deliverable once a
 * real, host-verified generation succeeded — never from agent-supplied
 * data.
 *
 * No approval handler is registered: this action can never hold, so there
 * is nothing for an approved replay to re-enter.
 *
 * Ported from old commit 59de60dc -- the registerDeliveryAction wiring
 * shape confirmed unchanged from current upstream. Only addition versus
 * the old file: the migration self-registration call.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleLeaseDocumentDelivery } from '../../db/migrations/module-lease-document-delivery.js';
import { registerDeliveryAction } from '../../delivery.js';
import { notifyAgent } from '../approvals/index.js';
import { applyLeaseDocumentDeliver } from './apply.js';
import { leaseDocumentDeliver } from './guard.js';
import { requestLeaseDocumentDeliverHold, validateLeaseDocumentDeliver } from './request.js';

registerMigration(moduleLeaseDocumentDelivery);

registerDeliveryAction('lease_document_deliver', applyLeaseDocumentDeliver, {
  guardAction: leaseDocumentDeliver,
  precheck: validateLeaseDocumentDeliver,
  requestHold: requestLeaseDocumentDeliverHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_document_deliver denied: ${reason}`),
});
