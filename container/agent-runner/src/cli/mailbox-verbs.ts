/**
 * Container-local mailbox verbs — `ncl inbox read` / `ncl outbox send`
 * (sandbox-spec D15; plan T4).
 *
 * The mailbox IS the transport — and since the upstream mailbox seam, the
 * transport is whatever the deployment registered: SQLite session files on
 * one box, an object store on another. So these verbs hold no storage
 * knowledge at all. They run against `getAgentMailbox()`, which ncl.ts has
 * already started for exactly this session, which is why local dispatch is
 * still the right shape: one round trip, and a host trip would add latency
 * and no authority.
 *
 * WHY NO HOST-SIDE HANDLER (the two-writer question). The CLI and the code
 * runner are separate processes, and an object store has no file lock to
 * arbitrate between them. Per-process instances are the seam's own contract
 * — upstream's `ncl` opens the registered mailbox, does one logical
 * operation and stops. But what the seam arbitrates and what it does not are
 * different answers for the two verbs here, so both are stated exactly:
 *
 * - `outbox send` IS covered. Sequence allocation lives inside
 *   `writeMessageOut()`, which is the whole point of the operation returning
 *   the sequence; the SQLite driver allocates the odd container lane under
 *   BEGIN IMMEDIATE across both files. This file used to run that
 *   `SELECT MAX(seq)` + `INSERT` itself, correct only because a file
 *   happened to lock, and three processes now write outbound (this verb,
 *   ncl.ts's own cli_request, and the mailbox-channel server's `reply`).
 *   Giving the RMW back to the driver is the real fix here.
 *
 * - `inbox read` is NOT covered, and an earlier version of this comment
 *   wrongly said it was ("two writers can only ever contend on the same
 *   message and the contended value is the same terminal ack"). Both halves
 *   are false. The delivery loop's other write for the SAME id is
 *   `markMessages(ids, 'processing')` — not terminal, not the same value —
 *   and `getPendingMessages()` + `markMessages()` are two seam calls with no
 *   transaction between them, exactly as the SELECT and the ack INSERTs were
 *   two statements before. The hazard is pre-existing and unchanged; what
 *   changed is only where the SQL lives.
 *
 * The one bad interleaving, in full: the loop reads a batch, this verb reads
 * the same batch and acks it 'completed', then the loop's `markProcessing`
 * overwrites that ack — the agent has already seen the mail here and the
 * loop injects it a second time, and if that injection never earns its hook
 * evidence the ids sit at 'processing' until the host's ~60s claim-stuck SLA
 * recycles the container. The reverse order is safe by construction:
 * `getPendingMessages` skips anything already carrying an ack, so a read
 * that starts after the claim sees nothing (pinned in the tests). Nothing is
 * ever LOST — the failure is a duplicate, at worst a recycle.
 *
 * The window is shut in the normal path, but by a gate rather than by
 * arbitration: the loop claims only while the agent-state file reads idle,
 * and this verb runs from a tool call, which is a busy turn. It is open in
 * exactly the loop's two declared degraded paths, where a live session is
 * treated as idle — no hook state after READY_FALLBACK_MS, and a busy stamp
 * stale past BUSY_STALE_MS.
 *
 * TODO(upstream/nanoclaw): closing it needs a compare-and-set the seam has
 * no word for — "ack this id only if it carries no ack" — the same missing
 * verb family the claim release used to be in, before it graduated onto
 * MailboxOperations as releaseProcessingClaims(ids). This one has not, and is
 * a coordination item for the same reason that one was. Not invented here, and deliberately not papered
 * over with a container-private lockfile: that would put a convenience lock
 * on the delivery path, which is the one thing the delivery loop is built
 * never to do.
 *
 * Contracts honored (see the recon in docs/sandbox/BUILD.md), unchanged:
 * - The container never writes the inbound side. "Consumed" is a terminal
 *   processing ack, and there is no un-ack path — reading consumes unless
 *   --peek. A consumed message remains fetchable forever via --id.
 * - Outbound rows take the container's odd-sequence lane and carry JSON
 *   content; routing defaults to the session's own routing (the origin
 *   chat), kind='chat' so delivery treats it exactly like any agent reply.
 */
import fs from 'fs';

import { getConfig } from '../config.js';
import {
  getMessageIn,
  getPendingMessages,
  markCompleted,
  writeMessageOut,
  type MessageInRow,
} from '../db/index.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getAgentMailbox } from '../mailbox/index.js';

/**
 * The one file these verbs still read by path — the host-written group
 * config, which is how the dispatch below tells a code-mode container from a
 * chat one. Not mailbox storage: that is the registered implementation's,
 * and this file never learns where it lives.
 */
export interface MailboxPaths {
  containerJson: string;
}

export const DEFAULT_PATHS: MailboxPaths = {
  containerJson: '/workspace/agent/container.json',
};

const INBOX_USAGE = 'usage: ncl inbox read [--peek] [--id <message-id>]  (default CONSUMES pending mail; --peek looks; --id fetches one, any state)';
const OUTBOX_USAGE = 'usage: ncl outbox send --text "..." [--reply-to <inbound-id>]';

/**
 * The mailbox verbs exist for CODE-MODE containers, whose delivery loop
 * shares the ack contract. In a chat container the poll loop owns
 * consumption — a local `inbox read` there would ack rows the poll loop
 * then silently never delivers. Read the host-written config directly: this
 * gate must not depend on the mailbox being reachable.
 */
function inCodeMode(paths: MailboxPaths): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(paths.containerJson, 'utf8')) as { codeMode?: boolean };
    return config.codeMode === true;
  } catch {
    return false;
  }
}

/** Reject stray flags BEFORE touching the mailbox — a typo must never consume the inbox. */
function unknownFlags(args: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(args).filter((k) => !allowed.includes(k));
}

type Frame =
  | { id: string; ok: true; data: unknown; human?: string }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface InboxMessage {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  sender: string;
  text: string;
  thread_id: string | null;
  channel_type: string | null;
  trigger: number;
}

function toMessage(row: MessageInRow): InboxMessage {
  let content: { text?: string; sender?: string; author?: { fullName?: string; userName?: string } };
  try {
    const parsed = JSON.parse(row.content);
    content = typeof parsed === 'object' && parsed !== null ? parsed : { text: row.content };
  } catch {
    content = { text: row.content };
  }
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    timestamp: row.timestamp,
    sender: content.sender || content.author?.fullName || content.author?.userName || 'unknown',
    text: content.text ?? row.content,
    thread_id: row.thread_id,
    channel_type: row.channel_type,
    trigger: row.trigger,
  };
}

function ok(data: unknown, human?: string): Frame {
  return { id: `local-${Date.now()}`, ok: true, data, human };
}

function err(message: string): Frame {
  return { id: `local-${Date.now()}`, ok: false, error: { code: 'handler-error', message } };
}

/**
 * The batch cap `getPendingMessages` applies. Upstream keeps the number
 * private to db/messages-in.ts, so it is read the same way here — and inside
 * `ncl` it is ALWAYS the fallback, because the CLI process never calls
 * loadConfig(). Which is exactly why it has to be visible to the agent: the
 * read is capped at ten, that ten is not the group's setting, and an
 * eleventh message is silently behind it.
 */
const DEFAULT_INBOX_BATCH = 10;

function inboxBatchCap(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    return DEFAULT_INBOX_BATCH;
  }
}

function renderMessages(messages: InboxMessage[], consumed: boolean, capped = false): string {
  const capNote = capped ? `\n(batch capped at ${inboxBatchCap()} — read again for the rest)` : '';
  if (messages.length === 0) return `inbox empty${capNote}`;
  const blocks = messages.map(
    (m) => `— ${m.sender} · ${m.timestamp} · id ${m.id}${m.trigger === 0 ? ' · context-only' : ''}\n${m.text}`,
  );
  const footer = consumed ? '' : '\n(peek — messages remain unread)';
  return blocks.join('\n\n') + footer + capNote;
}

/**
 * `ncl inbox read [--peek] [--id <id>]` — pending, unacked, non-system mail.
 * Default CONSUMES (acks 'completed'); --peek looks without consuming;
 * --id fetches one message by id regardless of ack state (how the agent
 * retrieves the full text behind an injected preview).
 *
 * The batch is the delivery loop's own: `getPendingMessages` already applies
 * the whole due/unclaimed contract, so an explicit read and an injection see
 * the same mail and never the mail the loop is mid-delivery on. It is
 * fetched as a WAKE poll (isFirstPoll) on purpose: an on_wake row the loop's
 * first poll has already gone past is otherwise unreachable, and an explicit
 * read is the one moment the agent has asked to see everything waiting.
 * kind='system' rows stay invisible either way: they are transport
 * envelopes (cli_request/cli_response, question answers), never mail, and
 * acking one here would eat the reply `ncl` itself is polling for.
 *
 * Borrowing the loop's fetch borrows its CAP, which the old hand-written
 * query did not have, so a full batch SAYS SO (`truncated` in the frame, a
 * line in the rendered text). Reading twelve messages and being shown ten
 * with no sign of the other two is a worse answer than either an uncapped
 * read or a capped one that admits it. The signal is the pre-filter batch
 * length, not the rendered count: system envelopes are dropped AFTER the
 * cap, so ten envelopes can hide real mail behind an "inbox empty" — which
 * then carries the note too.
 */
export async function inboxRead(args: Record<string, unknown>): Promise<Frame> {
  if (args.help === true) return ok(INBOX_USAGE, INBOX_USAGE);
  const stray = unknownFlags(args, ['peek', 'id']);
  if (stray.length > 0) return err(`unknown flag${stray.length > 1 ? 's' : ''} --${stray.join(', --')}\n${INBOX_USAGE}`);

  return getAgentMailbox().run(() => {
    if (typeof args.id === 'string' && args.id) {
      const row = getMessageIn(args.id);
      if (!row) return err(`no message ${args.id}`);
      const msg = toMessage(row);
      return ok({ message: msg }, renderMessages([msg], true));
    }

    const batch = getPendingMessages(true);
    const truncated = batch.length >= inboxBatchCap();
    const fresh = batch.filter((row) => row.kind !== 'system');
    const peek = args.peek === true;
    if (!peek && fresh.length > 0) markCompleted(fresh.map((row) => row.id));
    const messages = fresh.map(toMessage);
    return ok(
      { messages, consumed: !peek && fresh.length > 0, truncated },
      renderMessages(messages, !peek, truncated),
    );
  });
}

/**
 * `ncl outbox send --text "..." [--reply-to <inbound-id>]` — write one
 * outbound chat row. Routing: --reply-to copies the triggering inbound
 * message's routing (and sets inReplyTo for the a2a return path); otherwise
 * the session routing (the session's origin chat).
 */
export async function outboxSend(args: Record<string, unknown>): Promise<Frame> {
  if (args.help === true) return ok(OUTBOX_USAGE, OUTBOX_USAGE);
  const stray = unknownFlags(args, ['text', 'reply-to']);
  if (stray.length > 0) return err(`unknown flag${stray.length > 1 ? 's' : ''} --${stray.join(', --')}\n${OUTBOX_USAGE}`);

  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return err(`--text is required (free-text positionals do not survive ncl arg parsing)\n${OUTBOX_USAGE}`);

  return getAgentMailbox().run(async () => {
    let channelType: string | null;
    let platformId: string | null;
    let threadId: string | null;
    let inReplyTo: string | null = null;

    const replyTo = typeof args['reply-to'] === 'string' ? args['reply-to'] : '';
    if (replyTo) {
      const source = getMessageIn(replyTo);
      if (!source) return err(`no inbound message ${replyTo} to reply to`);
      channelType = source.channel_type;
      platformId = source.platform_id;
      threadId = source.thread_id;
      inReplyTo = replyTo;
    } else {
      const routing = getSessionRouting();
      if (!routing.platform_id && !routing.channel_type) {
        return err('no session routing — nothing to send to (use --reply-to <inbound-id>)');
      }
      channelType = routing.channel_type;
      platformId = routing.platform_id;
      threadId = routing.thread_id;
    }

    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // The container's odd-sequence lane is the seam's business now: every
    // implementation allocates it atomically (SQLite under BEGIN IMMEDIATE,
    // an object store under a conditional write), which is exactly the race
    // this verb used to run itself against a file that happened to lock.
    const seq = await writeMessageOut({
      id,
      kind: 'chat',
      in_reply_to: inReplyTo,
      platform_id: platformId,
      channel_type: channelType,
      thread_id: threadId,
      content: JSON.stringify({ text }),
    });
    return ok({ id, seq }, `sent (id ${id}, seq ${seq})`);
  });
}

/**
 * Local dispatch for the mailbox verbs. Returns null when the command is
 * not mailbox-local (caller falls through to the host transport).
 * `ncl inbox read <id>` arrives dash-joined as 'inbox-read-<id>' — the
 * positional is recovered by slicing the known prefix (there is no local
 * registry to do the host dispatcher's trim for us).
 */
export async function runMailboxVerb(
  command: string,
  args: Record<string, unknown>,
  paths: MailboxPaths = DEFAULT_PATHS,
): Promise<Frame | null> {
  const isMailbox = command === 'inbox-read' || command.startsWith('inbox-read-') || command === 'outbox-send';
  if (!isMailbox) return null;
  if (!inCodeMode(paths)) {
    // In a chat container these verbs must not exist locally — fall through
    // to the host transport, which answers unknown-command (and a future
    // host-side handler stays free to claim the names).
    return null;
  }
  if (command === 'inbox-read') return inboxRead(args);
  if (command.startsWith('inbox-read-')) {
    return inboxRead({ ...args, id: args.id ?? command.slice('inbox-read-'.length) });
  }
  return outboxSend(args);
}
