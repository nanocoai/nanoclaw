/**
 * Outbound text fixes for Telegram rich messages.
 *
 * @chat-adapter/telegram >= 4.41 sends agent replies through sendRichMessage,
 * whose markdown parser differs from what agents write in two ways:
 *
 * - `$…$` is inline math. A reply with two prices ("MU ~$950 … TSLA ~$403")
 *   renders everything between them as a formula, and `%` inside it starts a
 *   TeX comment that swallows the rest of the span. `\$` renders a plain `$`.
 * - A single newline is a soft break, so "• a\n• b" bullet lines collapse into
 *   one paragraph. A trailing backslash makes it a hard break.
 *
 * Code spans and fenced blocks are left untouched. The regular-message
 * fallback parses CommonMark too, so both escapes are safe there as well.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Lines that start a new block: a backslash hard break before one would render literally. */
const BLOCK_START = /^ {0,3}([-*+] |\d{1,9}[.)] |#{1,6}( |$)|>|\||`{3,}|~{3,}|$)/;
/** Lines where a trailing hard break is meaningless or would render literally. */
const NO_BREAK_AFTER = /^ {0,3}(#{1,6}( |$)|\||$)/;

function escapeDollars(line: string): string {
  // Split on inline code spans (matched backtick runs); escape only outside them.
  return line
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\\?\$/g, (m) => (m === '$' ? '\\$' : m))))
    .join('');
}

export function fixTelegramRichText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(FENCE)?.[1];

    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }

    let fixed = escapeDollars(line);
    const next = lines[i + 1];
    const softBreak =
      next !== undefined && !NO_BREAK_AFTER.test(line) && !BLOCK_START.test(next) && !/(\\| {2,})$/.test(line);
    if (softBreak) fixed += '\\';
    out.push(fixed);
  }
  return out.join('\n');
}
