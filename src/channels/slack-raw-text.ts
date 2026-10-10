/**
 * Recover pasted-table content from a raw Slack event.
 *
 * Slack sends pasted tables as attachment blocks instead of message text or
 * files. The Chat SDK adapter currently leaves those blocks only in
 * `message.raw`, which the host deliberately drops before persistence.
 */

const MAX_TABLE_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collect the text leaves in a Slack cell's raw_text/rich_text subtree. */
function cellText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.text === 'string') parts.push(node.text);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return parts.join(' ').trim();
}

export function extractSlackRawText(raw: Record<string, unknown>): string | null {
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const blocks = Array.isArray(attachment.blocks) ? attachment.blocks : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== 'table' || !Array.isArray(block.rows)) continue;
      for (const row of block.rows) {
        if (!Array.isArray(row)) continue;
        lines.push(row.map(cellText).join(' | '));
      }
    }
  }

  if (lines.length === 0) return null;
  const text = lines.join('\n');
  if (text.length <= MAX_TABLE_CHARS) return text;
  return `${text.slice(0, MAX_TABLE_CHARS - 20)}\n[table truncated]`;
}
