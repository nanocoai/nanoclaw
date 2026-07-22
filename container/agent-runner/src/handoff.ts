/**
 * Cross-provider conversation handoff.
 *
 * Each provider keeps its own private conversation thread (Claude a .jsonl
 * transcript, Codex a rollout) — so when quota forces a Claude→Codex switch,
 * the incoming engine has never seen what was just discussed, and when Claude
 * recovers it never saw the Codex-era turns. To the user this reads as "two
 * different people" (reported live 2026-07-08).
 *
 * The session DBs are the provider-agnostic source of truth: every user
 * message is in inbound.db (`messages_in`) and every delivered agent reply is
 * in outbound.db (`messages_out`), regardless of which engine authored it.
 * This module builds a compact recap of the recent exchange from those two
 * tables, to be prepended to the first prompt an engine sees after a switch
 * (in either direction) so it can pick up mid-conversation.
 */
import { getInboundDb, getOutboundDb } from './db/connection.js';

function log(msg: string): void {
  console.error(`[handoff] ${msg}`);
}

/** Max messages included in a recap (both sides combined, newest kept). */
const RECAP_MAX_MESSAGES = 12;
/** Per-message truncation. */
const RECAP_MSG_MAX_CHARS = 400;
/** Whole-recap budget — keeps the prefix cheap even with long messages. */
const RECAP_TOTAL_MAX_CHARS = 4000;

// System notices this pipeline itself injects (quota/fallback banners). They
// are noise inside a recap — the incoming engine needs the conversation, not
// our plumbing chatter.
const NOTICE_PREFIX_RE = /^[⚠️❌✅]/u;

interface ExchangeEntry {
  role: 'User' | 'You';
  ts: string;
  text: string;
}

/**
 * Build a `<system>` handoff prefix summarizing the recent exchange, or ''
 * when there is nothing useful (empty session, unreadable DBs — recap is
 * best-effort and must never block the turn itself).
 *
 * Direction-neutral on purpose: the same prompt segment can travel primary →
 * fallback within one turn (quota discovered mid-attempt), so the wording has
 * to make sense to whichever engine ends up reading it.
 */
export function buildHandoffRecap(): string {
  try {
    const entries: ExchangeEntry[] = [];

    const inRows = getInboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(RECAP_MAX_MESSAGES) as Array<{ timestamp: string; content: string }>;
    for (const r of inRows) {
      const text = extractText(r.content);
      if (text) entries.push({ role: 'User', ts: r.timestamp, text });
    }

    const outRows = getOutboundDb()
      .prepare(
        `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat'
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(RECAP_MAX_MESSAGES) as Array<{ timestamp: string; content: string }>;
    for (const r of outRows) {
      const text = extractText(r.content);
      if (text && !NOTICE_PREFIX_RE.test(text)) entries.push({ role: 'You', ts: r.timestamp, text });
    }

    if (entries.length === 0) return '';

    // Chronological, newest RECAP_MAX_MESSAGES across both sides.
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    const recent = entries.slice(-RECAP_MAX_MESSAGES);

    const lines: string[] = [];
    let budget = RECAP_TOTAL_MAX_CHARS;
    // Walk newest-first so the budget preferentially keeps recent turns,
    // then restore chronological order for readability.
    for (const e of [...recent].reverse()) {
      const t = e.text.length > RECAP_MSG_MAX_CHARS ? `${e.text.slice(0, RECAP_MSG_MAX_CHARS)}…` : e.text;
      const line = `[${e.role}] ${t.replace(/\s+/g, ' ').trim()}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.push(line);
    }
    lines.reverse();

    return (
      `<system>Engine handoff: this ongoing conversation switched engines or moved to a fresh thread. ` +
      `You may not have seen the most recent turns — they are recapped below, oldest ` +
      `first. Continue seamlessly as the same assistant: do not re-introduce yourself, do not mention the ` +
      `engine switch, and do not ask the user to resend anything they already provided.\n` +
      `Recent exchange:\n${lines.join('\n')}</system>\n\n`
    );
  } catch (err) {
    log(`recap failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

function extractText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}
