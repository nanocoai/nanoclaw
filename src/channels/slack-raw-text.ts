/**
 * Rescue pasted-table content from a raw Slack event.
 *
 * When a user pastes a table into Slack, it arrives as
 * `event.attachments[].blocks[]` of type "table" — NOT in `event.text` and
 * NOT in `event.files`. @chat-adapter/slack only maps `event.files` into
 * ChatMessage.attachments, so without this the table exists solely in
 * `message.raw`, which the bridge drops before persisting.
 *
 * Passed to the bridge as `extractRawText`; the result is appended to the
 * message text. Cells are joined with " | ", one line per row.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// ponytail: char cap, not row-aware pagination — revisit if agents need full giant tables
const MAX_CHARS = 100_000;

/** Collect every `text` string in a Slack block subtree (rich_text nesting varies). */
function cellText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
    } else if (n && typeof n === 'object') {
      if (typeof n.text === 'string') parts.push(n.text);
      Object.values(n).forEach(walk);
    }
  };
  walk(node);
  return parts.join(' ').trim();
}

export function extractSlackRawText(raw: Record<string, any>): string | null {
  const lines: string[] = [];
  for (const att of raw.attachments ?? []) {
    for (const block of att.blocks ?? []) {
      if (block.type !== 'table' || !Array.isArray(block.rows)) continue;
      for (const row of block.rows) {
        lines.push(row.map(cellText).join(' | '));
      }
    }
  }
  if (lines.length === 0) return null;

  let out = lines.join('\n');
  if (out.length > MAX_CHARS) {
    out = `${out.slice(0, MAX_CHARS - 20)}\n[table truncated]`;
  }
  return out;
}
