/**
 * stage_signed_lease_upload -- Pepper hands off a file Kirk uploaded (e.g.
 * a signed lease) so Lease Manager can file it. Durably copies the file
 * out of Pepper's ephemeral session inbox into Leases/Incoming -- which
 * sits inside the SAME tree already mounted read-only into Lease Manager's
 * container, so Lease Manager sees it immediately with zero new mount.
 * Pepper's own container never touches the bytes; this handler runs
 * host-side, same discipline as lease-document-delivery's apply.ts running
 * the opposite direction.
 *
 * ALLOW-only (see ./guard.ts) -- no approval card. Copying into a private
 * staging area is low-risk and fully reversible; the consequential step is
 * the later lease_fs_move that actually places the file into Current,
 * which does require approval.
 *
 * 2026-08-15 correction (carried forward from old commit 59de60dc, see its
 * own history): the only thing actually and reliably visible to the agent
 * is the composed attachment line itself -- formatter.ts's
 * formatAttachments() renders `[<type>: <name> — saved to
 * /workspace/<localPath>]`, where localPath IS exactly
 * `inbox/<messageId>/<filename>`. So this tool takes that whole path as one
 * opaque string (`attachment_path`) instead of asking the agent to
 * decompose or infer any ID -- it copies exactly what it can already see.
 *
 * Ported from old commit 59de60dc, adapted to await getMessagingGroup/
 * notifyAgent (now async) and the async central DB (`await getDb().run`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { INCOMING_DIR_RELATIVE, LEASE_MANAGER_ROOT_WSL, PEPPER_AGENT_GROUP_ID } from './config.js';

interface StagePayload {
  attachment_path: string;
  note?: string;
}

function isValidPayload(p: unknown): p is StagePayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.attachment_path !== 'string' || !row.attachment_path.trim()) return false;
  if (row.note !== undefined && typeof row.note !== 'string') return false;
  return true;
}

const WINDOWS_ILLEGAL_RE = /[\\/:*?"<>|]/g;

function sanitizeFilenameComponent(s: string): string {
  return s.replace(WINDOWS_ILLEGAL_RE, '').trim();
}

/** A single safe path segment: no slashes, no null bytes, not "." or "..", matches src/attachment-safety.ts's isSafeAttachmentName. */
function isSafeSegment(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return true;
}

export interface ResolvedAttachment {
  ok: true;
  messageId: string;
  filename: string;
  absolutePath: string;
}
export interface UnresolvedAttachment {
  ok: false;
  reason: string;
}

/**
 * Turns the exact string an agent copies out of its own conversation
 * (e.g. "/workspace/inbox/msg-abc123/lease.pdf" or the bare
 * "inbox/msg-abc123/lease.pdf") into a verified, on-disk path inside THIS
 * session's own inbox. Fails closed with a specific, diagnostic reason on
 * anything that doesn't match -- never guesses, never falls back to
 * scanning the inbox for "the" attachment.
 */
export function resolveAttachmentPath(
  agentGroupId: string,
  sessionId: string,
  attachmentPath: string,
): ResolvedAttachment | UnresolvedAttachment {
  let rel = attachmentPath.trim();
  if (rel.startsWith('/workspace/')) rel = rel.slice('/workspace/'.length);
  else if (rel.startsWith('workspace/')) rel = rel.slice('workspace/'.length);

  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length !== 3 || segments[0] !== 'inbox') {
    return {
      ok: false,
      reason:
        `attachment_path must be the exact path shown next to the attachment in this conversation, of the form ` +
        `"inbox/<id>/<filename>" (optionally prefixed "/workspace/") -- received ${JSON.stringify(attachmentPath)}.`,
    };
  }
  const [, messageId, filename] = segments;
  if (!isSafeSegment(messageId) || !isSafeSegment(filename)) {
    return {
      ok: false,
      reason: `attachment_path contains an invalid path segment -- received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  const candidate = path.join(inboxRoot, messageId, filename);

  let realInboxRoot: string;
  try {
    realInboxRoot = fs.realpathSync(inboxRoot);
  } catch {
    return {
      ok: false,
      reason: `this conversation has no inbox yet -- no attachment could have landed. Received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  if (!fs.existsSync(candidate)) {
    return {
      ok: false,
      reason: `no file exists at the resolved path (${path.relative(sessionDir(agentGroupId, sessionId), candidate)}) -- the attachment may already have been staged, or the path was mistyped. Received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    return { ok: false, reason: `could not resolve attachment path: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (real !== realInboxRoot && !real.startsWith(realInboxRoot + path.sep)) {
    return { ok: false, reason: "resolved path escapes this session's own inbox -- refusing." };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    return { ok: false, reason: 'resolved path is not a regular file.' };
  }
  if (path.extname(real).toLowerCase() !== '.pdf') {
    return {
      ok: false,
      reason: `only PDF attachments are accepted for signed-lease intake -- this file is "${path.extname(real) || '(no extension)'}".`,
    };
  }

  return { ok: true, messageId, filename, absolutePath: real };
}

export async function validateStageSignedLeaseUpload(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    await notifyAgent(session, 'stage_signed_lease_upload failed: not permitted for this agent.');
    log.warn('stage_signed_lease_upload: rejected non-Pepper caller', { agentGroupId: session.agent_group_id });
    return false;
  }
  if (!isValidPayload(content)) {
    await notifyAgent(session, 'stage_signed_lease_upload failed: attachment_path is required.');
    return false;
  }
  const resolved = resolveAttachmentPath(session.agent_group_id, session.id, content.attachment_path);
  if (!resolved.ok) {
    await notifyAgent(session, `stage_signed_lease_upload failed: ${resolved.reason}`);
    log.warn('stage_signed_lease_upload: precheck could not resolve attachment', { reason: resolved.reason });
    return false;
  }
  return true;
}

export async function applyStageSignedLeaseUpload(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    log.error('stage_signed_lease_upload apply: rejected non-Pepper session at apply time', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const stage = payload as unknown as StagePayload;
  const resolved = resolveAttachmentPath(session.agent_group_id, session.id, stage.attachment_path);
  if (!resolved.ok) {
    await notifyAgent(session, `stage_signed_lease_upload failed: ${resolved.reason}`);
    log.warn('stage_signed_lease_upload: apply-time resolution failed', { reason: resolved.reason });
    return;
  }

  const incomingDir = path.join(LEASE_MANAGER_ROOT_WSL, INCOMING_DIR_RELATIVE);
  fs.mkdirSync(incomingDir, { recursive: true });

  const id = randomUUID();
  const safeOriginalName = sanitizeFilenameComponent(resolved.filename) || 'upload';
  const stagedFilename = `${id} - ${safeOriginalName}`;
  const stagedPath = path.join(incomingDir, stagedFilename);

  fs.copyFileSync(resolved.absolutePath, stagedPath);

  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  const uploadedBy = mg ? `${mg.channel_type}:${mg.platform_id}` : 'unknown';
  const now = new Date().toISOString();

  await getDb().run(
    `INSERT INTO signed_lease_intake
       (id, staged_path, original_filename, uploaded_by, uploaded_via_message_id, note, staged_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?)`,
    id,
    stagedPath,
    resolved.filename,
    uploadedBy,
    resolved.messageId,
    stage.note ?? null,
    now,
    now,
  );

  await notifyAgent(
    session,
    `Staged. Reference: ${id}\n` +
      `Relative path: ${INCOMING_DIR_RELATIVE}/${stagedFilename}\n` +
      `Relay this reference (and any context Kirk gave you) to Lease Manager so it can file it.`,
  );
  log.info('stage_signed_lease_upload: applied', { id, originalFilename: resolved.filename });
}
