/**
 * Sanitize outbound text before the Telegram adapter converts it to MarkdownV2.
 *
 * The @chat-adapter/telegram adapter (≥4.x) uses parse_mode=MarkdownV2 and
 * runs a full CommonMark → MarkdownV2 conversion internally. This sanitizer
 * handles only things the adapter cannot fix on its own:
 *
 * - List bullets: `- item` is valid CommonMark list syntax and the adapter
 *   renders it as `\- item` (escaped dash). Replacing with `•` keeps the
 *   visual appearance intact while treating the line as prose.
 * - Horizontal rules: bare `---` / `***` / `___` lines have no MarkdownV2
 *   equivalent and create ambiguous delimiter runs in the adapter's parser.
 * - Unbalanced links: orphaned `[` or `]` confuse the CommonMark link parser;
 *   strip both when counts diverge.
 * - Underscores in link URLs: Telegram's real MarkdownV2 parser (not just the
 *   adapter's local one) throws "Can't find end of a URL" on some links whose
 *   URL contains an underscore — e.g. Wikipedia article slugs like
 *   `2026_Philippine_energy_crisis`. Escaping per the documented spec (only
 *   `)` and `\` need escaping inside a link URL) does not avoid this; the bug
 *   is server-side. Percent-encoding `_` to `%5F` sidesteps it — the URL
 *   still resolves identically since `%5F` and `_` are equivalent once
 *   decoded.
 * - Code spans/blocks: preserved verbatim via placeholder swap so none of the
 *   above rules touch their contents.
 *
 * Deliberately NOT done here: converting `**bold**` → `*bold*` or stripping
 * odd delimiter counts. The adapter's CommonMark parser handles `**bold**`
 * correctly (→ `*bold*` in MarkdownV2). Earlier versions of this function did
 * those conversions for a legacy-Markdown mode that no longer exists; they
 * caused a regex to mis-fire on constructs like `**title *italic***` and
 * produce malformed MarkdownV2 that Telegram rejected with "Can't find end of
 * Underline entity."
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Replace list bullets with a plain Unicode bullet so the adapter treats
  // the line as prose rather than a CommonMark list item.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules to a plain Unicode divider.
  text = text.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '⎯⎯⎯');

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  // Percent-encode underscores inside link/image URLs — see header comment.
  text = text.replace(/\]\(([^()\s]+)\)/g, (m, url: string) => `](${url.replace(/_/g, '%5F')})`);

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
