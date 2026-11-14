#!/usr/bin/env tsx
/**
 * why — explain what happened to one message.
 *
 * NanoClaw already records everything needed to answer "why didn't that
 * arrive?": `messages_out` (what the agent produced), `delivered` (what the
 * host got out to the platform), `messages_in` + `processing_ack` (what the
 * container did with an inbound). Nothing joins them.
 *
 * It is split on purpose. The two-DB single-writer design is what removes lock
 * contention, and it means the produced-message row and its delivery outcome
 * live in different files. So the join has to happen outside SQLite, and until
 * something does it there is no way to distinguish "delivered", "failed", and
 * "still sitting in the outbox" without reading two databases by hand.
 *
 * Read-only. Opens both session DBs with `readonly: true` and never writes.
 *
 *   tsx scripts/why.ts <message-id>
 *   tsx scripts/why.ts --stuck [--limit N]
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_ROOT = join(process.cwd(), 'data', 'v2-sessions');

/** A session directory holding an inbound.db / outbound.db pair. */
interface SessionDir {
  path: string;
  label: string;
}

/** Session dirs are nested <agent-group>/<session>/, but older installs put
 *  them at <session>/ directly. Accept both rather than guess. */
function findSessionDirs(root: string): SessionDir[] {
  if (!existsSync(root)) return [];
  const out: SessionDir[] = [];
  const walk = (dir: string, depth: number, label: string) => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'outbound.db'))) {
        out.push({ path: p, label: label ? `${label}/${entry}` : entry });
      } else {
        walk(p, depth + 1, label ? `${label}/${entry}` : entry);
      }
    }
  };
  walk(root, 0, '');
  return out;
}

function open(path: string): Database.Database | null {
  return existsSync(path) ? new Database(path, { readonly: true }) : null;
}

/** `2026-08-03T06:11:00Z` → `4h 12m`. Ages are what an operator actually reads. */
function age(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Render the destination an operator can grep for.
 *
 *  Chat SDK adapters (Telegram, Discord, Slack, …) namespace their own ids and
 *  send the prefixed form as platform_id — see src/platform-id.ts. Native
 *  adapters (WhatsApp, Signal, iMessage, DeltaChat) send bare JIDs, phone
 *  numbers or numeric ids. So the prefix has to be conditional: joining
 *  unconditionally printed `telegram:telegram:7061036646`, and dropping it
 *  unconditionally would lose the channel on every native adapter. */
export function formatDestination(channelType: string | null, platformId: string | null): string {
  if (!platformId) return channelType ?? '';
  if (!channelType) return platformId;
  return platformId.startsWith(`${channelType}:`) ? platformId : `${channelType}:${platformId}`;
}

/** One-line, operator-readable rendering of a stored message body.
 *
 *  Every body is JSON, and several are envelopes rather than text:
 *  ask_user_question and send_card write `type`, edit_message and add_reaction
 *  write `operation`, the self-mod tools write `action`. Dumping the raw JSON
 *  spent the whole 120-char budget on field names — an operator reading an
 *  ask_question row learned nothing about what was asked. Dispatch is on the
 *  envelope shape rather than on `kind`, because `kind` does not separate
 *  them: edit and reaction envelopes ride on kind 'chat'. */
export function previewContent(content: string): string {
  let body: unknown;
  try {
    body = JSON.parse(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- JSON.parse throws only SyntaxError, and a body that is not JSON is a legitimate input here
  } catch {
    return truncate(content); // not JSON — nothing to decode
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return truncate(content);
  const c = body as Record<string, unknown>;

  if (c.operation === 'edit') return truncate(`edit of ${str(c.messageId)} → "${str(c.text) || str(c.markdown)}"`);
  if (c.operation === 'reaction') return truncate(`reaction ${str(c.emoji)} on ${str(c.messageId)}`);

  if (c.type === 'ask_question') {
    const labels = (Array.isArray(c.options) ? c.options.map(optionLabel) : []).filter(Boolean);
    return truncate(`ask_question "${str(c.question) || str(c.title)}"${labels.length ? ` [${labels.join(', ')}]` : ''}`);
  }

  if (c.type === 'card') {
    const card = (c.card && typeof c.card === 'object' ? c.card : {}) as Record<string, unknown>;
    const blurb = str(card.description) || str(c.fallbackText);
    return truncate(`card "${str(card.title)}"${blurb ? ` — ${blurb}` : ''}`);
  }

  if (typeof c.action === 'string') return truncate(`action ${c.action}`);

  if (typeof c.text === 'string' || typeof c.markdown === 'string' || Array.isArray(c.files)) {
    const n = Array.isArray(c.files) ? c.files.length : 0;
    const files = n > 0 ? `(+${n} file${n === 1 ? '' : 's'})` : '';
    return truncate([str(c.markdown) || str(c.text), files].filter(Boolean).join(' '));
  }

  // A shape this predates. Show the JSON rather than an empty line, which an
  // operator would read as "no content".
  return truncate(content);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function optionLabel(o: unknown): string {
  if (typeof o === 'string') return o;
  return o && typeof o === 'object' ? str((o as Record<string, unknown>).label) : '';
}

function truncate(s: string): string {
  const flat = s.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

interface MessageOut {
  id: string; seq: number; timestamp: string; deliver_after: string | null;
  kind: string; channel_type: string | null; platform_id: string | null;
  thread_id: string | null; content: string; in_reply_to: string | null;
}
interface Delivered {
  message_out_id: string; platform_message_id: string | null;
  status: string; delivered_at: string;
}

function explain(id: string): number {
  const sessions = findSessionDirs(SESSIONS_ROOT);
  if (sessions.length === 0) {
    console.error(`no session databases under ${SESSIONS_ROOT}`);
    return 2;
  }

  for (const s of sessions) {
    const outbound = open(join(s.path, 'outbound.db'));
    if (!outbound) continue;

    const msg = outbound
      .prepare('SELECT * FROM messages_out WHERE id = ?')
      .get(id) as MessageOut | undefined;

    if (!msg) {
      // Not an outbound id — it may be an inbound the agent never answered.
      const inbound = open(join(s.path, 'inbound.db'));
      const incoming = inbound?.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as
        | { id: string; status: string; timestamp: string; tries: number; content: string }
        | undefined;
      if (incoming) {
        const ack = outbound
          .prepare('SELECT * FROM processing_ack WHERE message_id = ?')
          .get(id) as { status: string; status_changed: string } | undefined;
        reportInbound(s, incoming, ack, outbound);
        inbound?.close(); outbound.close();
        return 0;
      }
      inbound?.close(); outbound.close();
      continue;
    }

    const inbound = open(join(s.path, 'inbound.db'));
    const receipt = inbound
      ?.prepare('SELECT * FROM delivered WHERE message_out_id = ?')
      .get(id) as Delivered | undefined;

    reportOutbound(s, msg, receipt);
    inbound?.close(); outbound.close();
    return receipt?.status === 'delivered' ? 0 : 1;
  }

  console.log(`message ${id}\n  VERDICT: no record. Not in messages_out or messages_in in any session.`);
  return 2;
}

function reportOutbound(s: SessionDir, m: MessageOut, receipt: Delivered | undefined): void {
  const to = formatDestination(m.channel_type, m.platform_id) || '(no destination)';
  console.log(`message ${m.id}`);
  console.log(`  session   ${s.label}`);
  console.log(`  produced  ${m.timestamp}  (${age(m.timestamp)} ago), seq ${m.seq}, kind ${m.kind}`);
  console.log(`  to        ${to}${m.thread_id ? ` thread ${m.thread_id}` : ''}`);
  console.log(`  content   ${previewContent(m.content)}`);
  console.log();

  if (receipt?.status === 'delivered') {
    const latency = new Date(receipt.delivered_at).getTime() - new Date(m.timestamp).getTime();
    console.log(`  delivery  DELIVERED at ${receipt.delivered_at}` +
      (Number.isFinite(latency) ? ` (${Math.round(latency / 1000)}s after production)` : ''));
    if (receipt.platform_message_id) console.log(`            platform id ${receipt.platform_message_id}`);
    console.log(`\n  VERDICT: delivered. The platform accepted it.`);
    return;
  }

  if (receipt?.status === 'failed') {
    console.log(`  delivery  FAILED, recorded ${receipt.delivered_at} (${age(receipt.delivered_at)} ago)`);
    console.log(`\n  VERDICT: not delivered. The adapter reported a failure.`);
    console.log(`           Cause: the channel adapter rejected or errored on the send.`);
    console.log(`           Next:  grep this id in logs/nanoclaw.error.log for the adapter error.`);
    return;
  }

  // No receipt row at all — the interesting case, and the silent one.
  if (m.deliver_after && new Date(m.deliver_after).getTime() > Date.now()) {
    console.log(`  delivery  not yet due — deliver_after ${m.deliver_after}`);
    console.log(`\n  VERDICT: scheduled, not late. It is waiting for its send time.`);
    return;
  }

  console.log(`  delivery  NO RECORD in delivered`);
  console.log(`\n  VERDICT: not delivered, and nothing recorded why.`);
  console.log(`           The agent produced this message but the host never wrote a`);
  console.log(`           delivery outcome for it. It is sitting in the outbox.`);
  console.log(`           Cause: usually the delivery poll not running, no adapter`);
  console.log(`                  registered for '${m.channel_type ?? 'unknown'}', or the host`);
  console.log(`                  restarting between production and delivery.`);
  console.log(`           Next:  check the host is up, that the adapter for`);
  console.log(`                  '${m.channel_type ?? 'unknown'}' is installed and connected, then`);
  console.log(`                  look for this id in logs/nanoclaw.error.log.`);
}

function reportInbound(
  s: SessionDir,
  m: { id: string; status: string; timestamp: string; tries: number; content: string },
  ack: { status: string; status_changed: string } | undefined,
  outbound: Database.Database,
): void {
  console.log(`message ${m.id}  (inbound)`);
  console.log(`  session   ${s.label}`);
  console.log(`  received  ${m.timestamp} (${age(m.timestamp)} ago), status ${m.status}, tries ${m.tries}`);
  console.log(`  content   ${previewContent(m.content)}`);
  console.log();

  if (!ack) {
    console.log(`  VERDICT: the container never acknowledged this message.`);
    console.log(`           It was written to inbound.db but no processing_ack row exists,`);
    console.log(`           so the agent-runner has not polled it. Usually the container is`);
    console.log(`           not running. Check \`docker ps\` and logs/nanoclaw.error.log.`);
    return;
  }

  if (ack.status === 'completed') {
    console.log(`  VERDICT: processed. The agent completed this at ${ack.status_changed}.`);
    console.log(`           If you expected a reply, find it in messages_out and run`);
    console.log(`           \`why <that-id>\` — production and delivery are separate steps.`);
    return;
  }

  if (ack.status === 'processing') {
    const tool = outbound
      .prepare('SELECT current_tool, tool_started_at FROM container_state WHERE id = 1')
      .get() as { current_tool: string | null; tool_started_at: string | null } | undefined;
    console.log(`  VERDICT: still processing since ${ack.status_changed} (${age(ack.status_changed)} ago).`);
    if (tool?.current_tool) {
      console.log(`           The container is inside tool '${tool.current_tool}'` +
        (tool.tool_started_at ? `, started ${age(tool.tool_started_at)} ago.` : '.'));
      console.log(`           A long-running Bash step is normal; anything else this old is stuck.`);
    } else {
      console.log(`           No tool is in flight, so the agent is thinking or the container died`);
      console.log(`           mid-turn. The 60s host sweep clears stale 'processing' on restart.`);
    }
    return;
  }

  console.log(`  VERDICT: processing failed at ${ack.status_changed}.`);
  console.log(`           Check logs/nanoclaw.error.log around that timestamp.`);
}

/** List produced-but-undelivered messages across every session — the fleet-wide
 *  version of the same question, and the one an operator asks first. */
function stuck(limit: number): number {
  const rows: Array<{ session: string; id: string; ts: string; to: string }> = [];
  for (const s of findSessionDirs(SESSIONS_ROOT)) {
    const outbound = open(join(s.path, 'outbound.db'));
    const inbound = open(join(s.path, 'inbound.db'));
    if (!outbound || !inbound) { outbound?.close(); inbound?.close(); continue; }

    const delivered = new Set(
      (inbound.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>)
        .map((r) => r.message_out_id),
    );
    const out = outbound.prepare('SELECT * FROM messages_out ORDER BY timestamp DESC').all() as MessageOut[];
    for (const m of out) {
      if (delivered.has(m.id)) continue;
      if (m.deliver_after && new Date(m.deliver_after).getTime() > Date.now()) continue;
      rows.push({
        session: s.label, id: m.id, ts: m.timestamp,
        to: formatDestination(m.channel_type, m.platform_id) || '(none)',
      });
    }
    outbound.close(); inbound.close();
  }

  if (rows.length === 0) {
    console.log('no undelivered messages. Every produced message has a delivery record.');
    return 0;
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`${rows.length} produced but never delivered:\n`);
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${r.id}  ${r.to.padEnd(28)} ${age(r.ts).padStart(8)} ago   ${r.session}`);
  }
  if (rows.length > limit) console.log(`\n  …and ${rows.length - limit} more (--limit ${rows.length} to see all)`);
  console.log(`\nexplain one:  tsx scripts/why.ts <id>`);
  return 1;
}

// CLI — guarded so the formatting helpers above stay importable from tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`why — explain what happened to one message

  tsx scripts/why.ts <message-id>      explain one message (outbound or inbound)
  tsx scripts/why.ts --stuck [--limit N]  list produced-but-undelivered messages

Read-only. Run from the NanoClaw install root.`);
    process.exit(0);
  }

  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) || 20 : 20;
  process.exit(args[0] === '--stuck' ? stuck(limit) : explain(args[0]));
}
