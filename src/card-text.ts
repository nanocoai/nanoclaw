/**
 * Card-text helpers for untrusted values in host-built approval cards. They
 * depend on no channel: each channel escapes its own markup separately (see
 * the chat-sdk bridge's `escapeCardText`).
 */

const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu;
// An assigned emoji (plus an optional variation selector or skin tone) on each
// side of a joiner; Extended_Pictographic alone also covers reserved code points.
const EMOJI_BEFORE_RE = /(?=\p{Emoji})\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?$/u;
const EMOJI_AFTER_RE = /^(?=\p{Emoji})\p{Extended_Pictographic}/u;

/**
 * Render every control/format/invisible/bidi character — and backtick, so a
 * payload can never close a card's code fence — as a visible \uXXXX
 * escape. Applied to JSON-encoded payload fields: JSON.stringify already
 * escapes chars below 0x20, this covers the rest (Cf bidi/zero-width chars,
 * U+2028/U+2029 line separators, private-use, lone surrogates). A zero-width
 * joiner between two emoji is kept so joined emoji still render.
 */
export function escapeInvisibles(s: string): string {
  return s.replace(INVISIBLE_RE, (c, offset: number) => {
    if (
      c === '\u200d' &&
      EMOJI_BEFORE_RE.test(s.slice(Math.max(0, offset - 4), offset)) &&
      EMOJI_AFTER_RE.test(s.slice(offset + 1, offset + 3))
    ) {
      return c;
    }
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Quote an untrusted name or value for card text: one line, no fence or hidden
 * characters. Markdown renderers would decode `&#10;` into a line break and
 * turn `](` into a link that swallows host text, so both are shown escaped.
 */
export function quoteForCard(value: string): string {
  return escapeInvisibles(JSON.stringify(value))
    .replace(/&(?=#?[0-9A-Za-z]+;)/g, '\\u0026')
    .replace(/\]\(/g, ']\\u0028');
}

/** Appended by fenceForCard when it cuts text to its cap. */
export const TRUNCATED_MARK = '… (truncated)';

/**
 * Fence untrusted multi-line text for card text: lines kept, nothing inside can
 * close the fence. `maxLength` caps the escaped text (truncation mark
 * included), cut never inside an escape or a surrogate pair, since escaping
 * can grow text several times.
 */
export function fenceForCard(text: string, maxLength?: number): string {
  // Escaping never shortens text, so a raw prefix one past the cap is enough.
  const raw = maxLength !== undefined && text.length > maxLength ? text.slice(0, maxLength + 1) : text;
  let body = raw.split('\n').map(escapeInvisibles).join('\n');
  if (maxLength !== undefined && body.length > maxLength) {
    const cut = body
      .slice(0, Math.max(0, maxLength - TRUNCATED_MARK.length))
      .replace(/\\(?:u(?:\{[0-9a-f]*|[0-9a-f]{0,3})?)?$/, '')
      .replace(/[\uD800-\uDBFF]$/, '');
    body = cut + TRUNCATED_MARK;
  }
  return '```\n' + body + '\n```';
}
