/**
 * Guarded handler body for lease_document_deliver.
 *
 * Runs synchronously on the guard's `allow` decision (there is no hold/
 * approval round trip for this action — see ./guard.ts). Re-validates
 * everything independently rather than trusting the precheck's result
 * (same discipline as lease-manager-generate/apply.ts): resolves the
 * document reference fresh, confirms the calling session's own wired
 * destination is exactly Kirk's trusted Telegram conversation (not just
 * "some Telegram chat"), reads the file host-side, and calls the channel
 * delivery adapter directly — the same `deliver()` the normal outbound
 * poll loop uses, just invoked here instead of through the container
 * outbox, because Pepper's container never has (and must never need) the
 * file's bytes or path.
 *
 * Every attempt — success or failure — gets one row in
 * lease_document_deliveries. A failure never touches, deletes, renames, or
 * regenerates the source file: nothing in this module ever opens
 * document.filePath for anything but a read.
 *
 * Ported from old commit 59de60dc, adapted to await getMessagingGroup/
 * notifyAgent (now async), resolveAndValidateDocument (now async), and
 * the async central DB (`await getDb().run`). getDeliveryAdapter() and
 * adapter.deliver()'s signature (channelType, platformId, threadId, kind,
 * content, files?) confirmed unchanged from current upstream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { KIRK_TELEGRAM_CHANNEL_TYPE, KIRK_TELEGRAM_PLATFORM_ID, PEPPER_AGENT_GROUP_ID } from './config.js';
import { resolveAndValidateDocument, type ResolvedDocument } from './resolve.js';

async function recordDeliveryAttempt(
  documentId: string,
  status: 'success' | 'failed',
  error: string | null,
  destinationChannelType: string,
  destinationPlatformId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO lease_document_deliveries
       (id, document_id, attempted_at, status, error, destination_channel_type, destination_platform_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    documentId,
    now,
    status,
    error,
    destinationChannelType,
    destinationPlatformId,
    now,
  );
}

export async function applyLeaseDocumentDeliver(payload: Record<string, unknown>, session: Session): Promise<void> {
  // Re-check even though request.ts's precheck already gated this.
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    log.error('lease_document_deliver apply: rejected non-Pepper session at apply time', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const result = await resolveAndValidateDocument(payload.document_reference);
  if (!result.ok) {
    await notifyAgent(session, `lease_document_deliver failed: ${result.reason}`);
    log.warn('lease_document_deliver: apply-time resolution rejected', { reason: result.reason });
    return;
  }
  const document: ResolvedDocument = result.document;

  // Fail closed on destination too: the session's own wired chat must be
  // exactly Kirk's trusted Telegram conversation, not "some Telegram chat" —
  // this is v1's whole Telegram-scope boundary, enforced host-side rather
  // than assumed from "well, Pepper only has one wiring today."
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  if (!mg || mg.channel_type !== KIRK_TELEGRAM_CHANNEL_TYPE || mg.platform_id !== KIRK_TELEGRAM_PLATFORM_ID) {
    const reason = `delivery destination is not Kirk's trusted Telegram conversation (resolved ${mg?.channel_type ?? 'none'}/${mg?.platform_id ?? 'none'}).`;
    await recordDeliveryAttempt(document.id, 'failed', reason, mg?.channel_type ?? 'unknown', mg?.platform_id ?? 'unknown');
    await notifyAgent(session, `lease_document_deliver failed: ${reason} The source file was not touched.`);
    log.error('lease_document_deliver: destination check failed', { reason, sessionId: session.id });
    return;
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(document.filePath);
  } catch (e) {
    const reason = `could not read the document file: ${e instanceof Error ? e.message : String(e)}`;
    await recordDeliveryAttempt(document.id, 'failed', reason, mg.channel_type, mg.platform_id);
    await notifyAgent(session, `lease_document_deliver failed: ${reason} The source file was not touched.`);
    log.error('lease_document_deliver: file read failed', { reason, documentId: document.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    const reason = 'the delivery channel is not currently available.';
    await recordDeliveryAttempt(document.id, 'failed', reason, mg.channel_type, mg.platform_id);
    await notifyAgent(
      session,
      `lease_document_deliver failed: ${reason} The source file was not touched. Please tell Kirk delivery failed and retry shortly.`,
    );
    log.error('lease_document_deliver: no delivery adapter set', { documentId: document.id });
    return;
  }

  const filename = path.basename(document.filePath);
  const caption =
    typeof payload.caption === 'string' && payload.caption.trim()
      ? payload.caption
      : `Lease draft for ${document.propertyAddress} — for your review.`;

  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat',
      JSON.stringify({ text: caption }),
      [{ filename, data }],
    );
  } catch (e) {
    const reason = `Telegram delivery failed: ${e instanceof Error ? e.message : String(e)}`;
    await recordDeliveryAttempt(document.id, 'failed', reason, mg.channel_type, mg.platform_id);
    await notifyAgent(
      session,
      `lease_document_deliver failed: ${reason} The source file was not touched. Please tell Kirk delivery failed.`,
    );
    log.error('lease_document_deliver: adapter.deliver threw', { reason, documentId: document.id });
    return;
  }

  await recordDeliveryAttempt(document.id, 'success', null, mg.channel_type, mg.platform_id);
  await notifyAgent(
    session,
    `Document delivered to Kirk's Telegram: ${filename} (property: ${document.propertyAddress}). ` +
      `You can now tell him the lease was generated successfully, saved in Drafts, and a copy is attached above for his review.`,
  );
  log.info('lease_document_deliver: applied', {
    documentId: document.id,
    generationRequestId: document.generationRequestId,
  });
}
