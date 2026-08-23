/**
 * Resolving worker identity for Maintenance Coordinator's actions.
 *
 * Two shapes of messaging group, two resolution strategies:
 *
 * - Private 1:1 DM (is_group=0): the DM's own platform_id *is* the
 *   worker's identity -- the same pattern approval routing already relies
 *   on for Kirk's own DM. No separate lookup table maps session to
 *   worker; the session's own messaging group already carries it.
 *
 * - Shared group (is_group=1): the messaging group's platform_id is the
 *   GROUP CHAT's id, not any individual's -- Kirk, Ivan, and Elehazar all
 *   share one messaging_groups row and one session. Falling back to
 *   mg.platform_id here would silently misattribute every action to a
 *   nonexistent "worker" (the chat itself), indistinguishable between
 *   whoever actually sent the triggering message. For a group, the caller
 *   MUST supply sourceMessageId -- the id shown on the specific
 *   `<message id="...">` the agent is acting on -- and identity is
 *   resolved by looking up that exact message's own stored content and
 *   reading the sender id the router/adapter captured for it (structural,
 *   from Telegram's real per-message `from.id` via the channel adapter,
 *   never the agent's own claim about who sent it and never message
 *   text/display name). An unresolvable or missing reference fails
 *   closed -- no guessing, no falling back to the group's own identity.
 *
 * Ported from old commit 824318ff, adapted: getMessagingGroup() is now
 * async; the old direct-file `withInboundDb` helper no longer exists
 * (superseded by the mailbox abstraction) -- exact-seq message lookup now
 * goes through the new InboundMailbox.getInboundMessageBySeq(seq) method
 * (added alongside this port; the mailbox abstraction previously had no
 * single-message-by-seq reader, only getInboundHistory(limit)) via
 * withExistingMailboxSession, mirroring the pattern already established by
 * maintenance-transcript/search.ts. findWorker() here is now async
 * (already ported in Priority 2) -- unchanged by this pass.
 */
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

export async function resolveWorkerUserId(session: Session): Promise<string | null> {
  if (!session.messaging_group_id) return null;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return null;
  return mg.platform_id.includes(':') ? mg.platform_id : `${mg.channel_type}:${mg.platform_id}`;
}

interface ParsedMessageContent {
  senderId?: string;
  sender?: string;
  author?: { userId?: string };
}

function safeParseMessageContent(raw: string): ParsedMessageContent {
  try {
    return JSON.parse(raw) as ParsedMessageContent;
  } catch {
    return {};
  }
}

/**
 * Looks up one specific inbound message by its `seq` (the value shown to
 * the agent as `<message id="...">`) and extracts the real, structurally
 * captured sender id from its stored content -- never from anything the
 * agent asserts. Returns null on any lookup/parse failure or a message
 * with no recoverable sender id (e.g. a task/system row).
 */
async function resolveVerifiedSenderIdForMessage(
  agentGroupId: string,
  sessionId: string,
  sourceMessageId: string,
): Promise<string | null> {
  const seq = Number(sourceMessageId);
  if (!Number.isInteger(seq) || seq <= 0) return null;

  try {
    const row = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      mailbox.getInboundMessageBySeq(seq),
    );
    if (!row) return null;
    const parsed = safeParseMessageContent(row.content);
    const raw = parsed.senderId || parsed.author?.userId || null;
    if (!raw) return null;
    // Real adapters (e.g. Telegram via chat-sdk) capture the sender id bare
    // -- no channel prefix -- while workers.user_id is always stored
    // channel-prefixed (`telegram:<id>`). Normalize using the *stored
    // message's own* channel_type, never a claimed or derived one, so a
    // structurally verified sender still matches its workers row.
    if (raw.includes(':')) return raw;
    if (!row.channelType) return null;
    return `${row.channelType}:${raw}`;
  } catch {
    // No inbound.db yet, a corrupt read, or any other open/query failure --
    // fail closed the same as "message not found", never throw out of an
    // identity check.
    return null;
  }
}

export interface WorkerIdentityResult {
  ok: boolean;
  userId?: string;
  reason?: string;
}

/**
 * The strict, group-aware identity resolver every maintenance worker
 * action should use for "who is this action about" (the acting/reporting
 * worker -- never for the `about_worker`/`transported_by`/`holder_worker`
 * *subject* fields, which are always resolved by name via findWorker()
 * and were never an authentication path).
 */
export async function resolveActingWorkerUserId(
  session: Session,
  sourceMessageId?: string,
): Promise<WorkerIdentityResult> {
  if (!session.messaging_group_id) {
    return {
      ok: false,
      reason: 'could not resolve which worker this session belongs to (no messaging group on this session).',
    };
  }
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    return { ok: false, reason: 'could not resolve which worker this session belongs to (messaging group not found).' };
  }

  if (mg.is_group === 1) {
    if (!sourceMessageId) {
      return {
        ok: false,
        reason:
          'this is a shared group conversation -- source_message_id is required (the id shown on the message you are acting on) so the right person gets credited.',
      };
    }
    const verified = await resolveVerifiedSenderIdForMessage(session.agent_group_id, session.id, sourceMessageId);
    if (!verified) {
      return {
        ok: false,
        reason: `could not verify the sender of message ${sourceMessageId} in this group -- not recording this against anyone. Ask again if needed.`,
      };
    }
    return { ok: true, userId: verified };
  }

  // Private 1:1 DM: prefer a verified per-message sender when given (more
  // precise, and exercises the same code path as groups), but fall back to
  // the DM's own identity -- this is exactly the already-tested behavior,
  // unchanged.
  if (sourceMessageId) {
    const verified = await resolveVerifiedSenderIdForMessage(session.agent_group_id, session.id, sourceMessageId);
    if (verified) return { ok: true, userId: verified };
  }
  const fallback = await resolveWorkerUserId(session);
  if (!fallback) {
    return { ok: false, reason: 'could not resolve which worker this session belongs to.' };
  }
  return { ok: true, userId: fallback };
}

export interface WorkerRow {
  user_id: string;
  name: string;
  preferred_language: string;
  role: string;
  can_drive_independently: number;
  usual_transport_provider: string | null;
}

export interface WorkerLookupResult {
  ok: boolean;
  worker?: WorkerRow;
  reason?: string;
}

/**
 * Resolve a worker by user_id, or by a case-insensitive name match (how a
 * caller naturally refers to a co-worker, e.g. "Elehazar"). Fails closed
 * (never silently picks one) if a name matches more than one worker --
 * "one worker's records cannot be confused with another's" is a hard
 * requirement for the historical-query tools this feeds.
 */
export async function findWorker(reference: string): Promise<WorkerLookupResult> {
  const byId = await getDb().get<WorkerRow>('SELECT * FROM workers WHERE user_id = ?', reference);
  if (byId) return { ok: true, worker: byId };

  const matches = await getDb().all<WorkerRow>('SELECT * FROM workers WHERE lower(name) = lower(?)', reference);
  if (matches.length === 0) {
    return { ok: false, reason: `no worker found matching "${reference}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `"${reference}" matches ${matches.length} workers (${matches.map((w) => w.user_id).join(', ')}) -- ambiguous, refusing to guess. Use the worker's user_id instead.`,
    };
  }
  return { ok: true, worker: matches[0] };
}
