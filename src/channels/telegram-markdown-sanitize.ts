/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

// @chat-adapter/telegram's own pre-send safety net — trimToMarkdownV2SafeBoundary
// (node_modules/@chat-adapter/telegram/dist/index.js) — scans the FINAL rendered
// text for unescaped *, _, ~, ` and silently truncates at the last unpaired one
// if the total count is odd. It runs unconditionally (even when nothing needs
// truncating for length) and doesn't know a link *destination* is exempt from
// entity parsing — one bare `_` there (e.g. GitLab's /-/merge_requests/) is an
// odd count on its own, so it chops the message right before the link. This is
// NOT the same bug as the delimiter-parity check below (that one is ours, in
// this file); it's upstream, in the adapter package, and survives even after
// wrapping the URL in `[label](dest)` — only the label gets backslash-escaped
// by the adapter's own round-trip, the destination doesn't. Percent-encoding
// these four chars in the destination (not the label, so it stays readable)
// sidesteps it — GitLab and every other server decode %5F etc. transparently,
// confirmed the encoded and literal URLs 302 identically.
const MARKDOWN_V2_TRIM_TRIGGER_CHARS = /[_*~`]/g;
function encodeLinkDestination(url: string): string {
  return url.replace(MARKDOWN_V2_TRIM_TRIGGER_CHARS, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Existing markdown links (e.g. `[docs](https://example.com/a_b)`) hide
  // their URL from the bare-URL wrap below and get placeholder-protected
  // here first, so an underscore in the link *destination* survives the
  // delimiter-parity stripping a few lines down same as a code span would.
  // The destination also gets percent-encoded (see encodeLinkDestination
  // above) so the adapter's own post-render safe-boundary trim doesn't choke
  // on it after this function returns — protecting it here isn't enough,
  // since that trim runs downstream of this whole sanitizer.
  const LINK_PATTERN = /\[([^[\]\n]*)\]\(([^()\n]*)\)/g;
  text = text.replace(LINK_PATTERN, (_m, label: string, url: string) => {
    codeSegments.push(`[${label}](${encodeLinkDestination(url)})`);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Bare URLs (not already in a markdown link or code span, both already
  // placeholder-protected above) commonly contain underscores — GitLab's
  // /-/merge_requests/ path is the recurring offender. The delimiter-parity
  // check below can't tell a URL's underscore from a real _italic_ marker,
  // and Telegram's own legacy-Markdown parser chokes on an unescaped `_`
  // inside a bare URL ("can't find end of a URL"), silently dropping the
  // message after retries exhaust. Wrapping in `[url](url)` moves the
  // underscore into the link *destination* — encoded there too, same reason
  // as the existing-link case above. Protected via the same placeholder
  // mechanism as code spans (not inlined directly) so the parity/bracket
  // checks below can't see or strip its `_` or `[`/`]` — those checks run on
  // raw regex counts, not real parse state.
  text = text.replace(/\bhttps?:\/\/[^\s<>\])]+/g, (m) => {
    codeSegments.push(`[${m}](${encodeLinkDestination(m)})`);
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

  const starCount = (text.match(/\*/g) ?? []).length;
  const underCount = (text.match(/_/g) ?? []).length;
  if (starCount % 2 !== 0 || underCount % 2 !== 0) {
    text = text.replace(/[*_]/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
