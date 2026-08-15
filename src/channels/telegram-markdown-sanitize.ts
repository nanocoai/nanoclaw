/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

// Bare URLs that the chat-adapter would otherwise CommonMark-autolink into
// `[url](url)` form. Underscores inside the resulting label become unbalanced
// italic delimiters that Telegram's legacy Markdown parser rejects with
// "can't parse entities: Can't find end of the entity starting at byte offset N".
// Percent-encoding `_` to `%5F` keeps the URL clickable (clients decode it)
// while removing the parser-confusing character.
const URL_PATTERN = /https?:\/\/\S+/g;

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  let text = input.replace(URL_PATTERN, (url) => url.replace(/_/g, '%5F'));

  const codeSegments: string[] = [];
  text = text.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules (bare --- / *** / ___ lines) to a
  // plain Unicode divider. The parser doesn't understand HR syntax and the
  // `*` / `_` characters would otherwise unbalance the delimiter counts below.
  text = text.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '⎯⎯⎯');

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  // Strip independently so an unbalanced count of one delimiter doesn't also
  // wipe out the (balanced) formatting of the other.
  if ((text.match(/\*/g) ?? []).length % 2 !== 0) {
    text = text.replace(/\*/g, '');
  }
  if ((text.match(/_/g) ?? []).length % 2 !== 0) {
    text = text.replace(/_/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  // Any backtick remaining after code extraction is stray — it was never part of
  // a valid code span. Telegram's legacy Markdown parser would open a code entity
  // at that position and never find the closing backtick, causing a parse error.
  text = text.replace(/`/g, '');

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
