/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getInboundSourceSessionId, getMostRecentPeerSourceSessionId } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import {
  openInboundDb,
  resolveSafeInboxDir,
  resolveSession,
  sessionDir,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export { isSafeAttachmentName };

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const safeInbox = resolveSafeInboxDir(target.agentGroupId, target.sessionId, target.messageId);
  if (!safeInbox) {
    log.warn('agent-route: rejecting unsafe target inbox, no files forwarded', {
      targetMsgId: target.messageId,
      targetSessionId: target.sessionId,
    });
    return [];
  }
  const targetInboxDir = safeInbox.inboxDir;

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 */
function resolveTargetSession(msg: RoutableAgentMessage, sourceSession: Session, targetAgentGroupId: string): Session {
  const srcDb = openInboundDb(sourceSession.agent_group_id, sourceSession.id);
  let originSessionId: string | null = null;
  try {
    if (msg.in_reply_to) {
      originSessionId = getInboundSourceSessionId(srcDb, msg.in_reply_to);
    }
    if (!originSessionId) {
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      originSessionId = getMostRecentPeerSourceSessionId(srcDb, targetAgentGroupId);
    }
  } finally {
    srcDb.close();
  }
  if (originSessionId) {
    const candidate = getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      return candidate;
    }
  }
  return resolveSession(targetAgentGroupId, null, null, 'agent-shared').session;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  const targetSession = resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
    sourceSessionId: session.id,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
