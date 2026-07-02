/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  upsertSessionRouting,
  insertMessage,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/**
 * @deprecated Use inboundDbPath / outboundDbPath instead.
 * Kept temporarily for test compatibility during migration.
 */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return inboundDbPath(agentGroupId, sessionId);
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * 1 = this message should wake the agent (the default); 0 = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a trigger-1 message does arrive.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path so the target's reply routes back to that exact session.
     */
    sourceSessionId?: string | null;
    /**
     * 1 = only deliver on the container's first poll (fresh start).
     * Dying containers (past first poll) skip these rows.
     */
    onWake?: 0 | 1;
  },
): void {
  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    insertMessage(db, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? 1,
      sourceSessionId: message.sourceSessionId ?? null,
      onWake: message.onWake ?? 0,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so a compromised agent can also
 * pre-place a symlink at `inbox/<future msgId>/` and wait for a chat message
 * with a matching id to redirect the host's write.
 *
 * Defenses, mirrored from the outbound side:
 *   1. basename check on `messageId` and `filename`.
 *   2. lstat of the inbox dir to refuse pre-placed symlinks.
 *   3. realpath-based containment under the session inbox root.
 *   4. `wx` flag on writeFileSync to refuse following a pre-existing symlink
 *      at the target file path or overwriting any existing file.
 */
function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return contentStr;
  }

  const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  // Resolved lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  // ensureContainedInboxDir refuses a pre-placed symlink at the inbox root or
  // the per-message subdir before any write lands outside the sandbox (#2828).
  let inboxDir: string | null = null;
  let inboxResolved = false;

  let changed = false;
  for (const att of attachments) {
    if (typeof att.data !== 'string') continue;

    const rawName = deriveAttachmentName(att);
    const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
    if (filename !== rawName) {
      log.warn('Refused unsafe attachment filename, would escape inbox', {
        messageId,
        rawName,
        replacement: filename,
      });
    }

    if (!inboxResolved) {
      inboxDir = ensureContainedInboxDir(inboxRoot, messageId, { messageId });
      inboxResolved = true;
    }
    // Unsafe inbox (symlink / escape) — no attachment can be written safely.
    if (!inboxDir) break;

    const filePath = path.join(inboxDir, filename);
    try {
      // wx = exclusive create. Refuses to follow a pre existing symlink or
      // overwrite any existing file. The host expects to be the sole writer
      // of these attachments.
      fs.writeFileSync(filePath, Buffer.from(att.data as string, 'base64'), { flag: 'wx' });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        log.warn('Inbox attachment target already exists, refusing to overwrite', {
          messageId,
          filename,
        });
        continue;
      }
      throw err;
    }

    att.name = filename;
    att.localPath = `inbox/${messageId}/${filename}`;
    delete att.data;
    changed = true;
    log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  migrateMessagesInTable(db);
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 *
 * Needs the read-write open — the readonly handle the delivery poll uses
 * can't INSERT. This is a host-side write to the container-owned outbound.db,
 * but it's safe even with a container running: both sides open with DELETE
 * journal + busy_timeout, and the even host seq stays out of the container's
 * odd-seq space.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  const db = openOutboundDbRw(agentGroupId, sessionId);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?)`,
    ).run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  } finally {
    db.close();
  }
}

/**
 * @deprecated Use openInboundDb / openOutboundDb instead.
 */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDb(agentGroupId, sessionId);
}

/** Write a system response to a session's inbound.db so the container's findQuestionResponse() picks it up. */
export function writeSystemResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  status: string,
  result: Record<string, unknown>,
): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `sys-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'question_response',
      questionId: requestId,
      status,
      result,
    }),
  });
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return undefined;

  let realOutboxDir: string;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox directory', { messageId, outboxDir });
      return undefined;
    }
    realOutboxDir = fs.realpathSync(outboxDir);
  } catch (err) {
    log.warn('Failed to inspect outbox directory', { messageId, err });
    return undefined;
  }

  const files: OutboundFile[] = [];
  for (const filename of filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
      continue;
    }

    const filePath = path.join(outboxDir, filename);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        log.warn('Rejecting unsafe outbox file', { messageId, filename });
        continue;
      }
      const realFilePath = fs.realpathSync(filePath);
      if (!isPathInside(realOutboxDir, realFilePath)) {
        log.warn('Rejecting outbox file outside message directory', { messageId, filename });
        continue;
      }
      files.push({ filename, data: fs.readFileSync(realFilePath) });
    } catch {
      log.warn('Outbox file not found', { messageId, filename });
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox cleanup directory', { messageId, outboxDir });
      return;
    }
    const realOutboxBase = fs.realpathSync(path.join(sessionDir(agentGroupId, sessionId), 'outbox'));
    const realOutboxDir = fs.realpathSync(outboxDir);
    if (!isPathInside(realOutboxBase, realOutboxDir)) {
      log.warn('Rejecting outbox cleanup outside session outbox', { messageId, outboxDir });
      return;
    }
    fs.rmSync(realOutboxDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  }
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
