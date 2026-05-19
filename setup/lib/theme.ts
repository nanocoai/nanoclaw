/**
 * NanoClaw brand palette for the terminal.
 *
 * Colors pulled from assets/nanoclaw-logo.png:
 *   brand cyan  ≈ #2BB7CE  — the "Claw" wordmark + mascot body
 *   brand navy  ≈ #171B3B  — the dark logo background + outlines
 *
 * Rendering gates:
 *   - No TTY (piped / redirected) → plain text, no ANSI
 *   - NO_COLOR set               → plain text, no ANSI
 *   - COLORTERM truecolor/24bit  → 24-bit ANSI (exact brand cyan)
 *   - Otherwise                  → kleur's 16-color cyan (closest fallback)
 */
import * as p from '@clack/prompts';
import k from 'kleur';

const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

export function brand(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
}

export function brandBold(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
}

export function brandChip(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${s}\x1b[0m`;
  }
  return k.bgCyan(k.black(k.bold(s)));
}

/**
 * Accent green (#3fba50) for emphasizing a single word inside prompt
 * messages — currently the "you" in "What should your assistant call
 * you?" so the operator parses at a glance who the question is about.
 * Same TTY/NO_COLOR/truecolor gating as the rest of the palette.
 */
export function accentGreen(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;63;186;80m${s}\x1b[39m`;
  return k.green(s);
}

/**
 * Format an elapsed-time duration (in milliseconds) for the spinner
 * suffixes setup writes everywhere. Sub-minute durations stay in plain
 * seconds (`47s`); once the timer crosses 60 seconds we switch to the
 * `Xm Ys` form (`2m 34s`) so a long step doesn't read as `247s` or
 * similar. The format is consistent above 60s — `4m 0s` over `4m` —
 * so live spinner output doesn't change shape at every whole minute.
 */
export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/**
 * Brand body color for setup-flow prose. Used for card bodies (via the
 * `note()` formatter) and `p.log.*` body arguments — anywhere the
 * previous "dim" treatment was making prose hard to read or washing
 * out embedded brand emphasis.
 *
 * Multi-line input is colored line-by-line so embedded line breaks
 * don't bleed the SGR sequence across clack's gutter prefix.
 */
export function brandBody(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return s
      .split('\n')
      .map((line) => (line.length > 0 ? `\x1b[38;2;43;183;206m${line}\x1b[39m` : line))
      .join('\n');
  }
  return s
    .split('\n')
    .map((line) => (line.length > 0 ? k.cyan(line) : line))
    .join('\n');
}

/**
 * Wrap text so it fits inside clack's gutter without the terminal's soft
 * wrap breaking the `│ …` bar on long lines. Works on a single string with
 * embedded `\n`s; each logical line is wrapped independently.
 *
 * The `gutter` argument is the total horizontal overhead clack adds for
 * the component the text lives in (e.g. 4 for `p.log.*`'s `│  ` prefix;
 * 6-ish for `p.note`'s box). Caller picks it; we just subtract from
 * `process.stdout.columns` and hard-wrap at word boundaries.
 */
export function wrapForGutter(text: string, gutter: number): string {
  const cols = process.stdout.columns ?? 80;
  const width = Math.max(30, cols - gutter);
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

/**
 * Wrap multi-line explanatory prose to the clack gutter. Previously
 * dimmed its output (hence the name) — that made body copy hard to read
 * against dark terminals. Dim is now reserved for preview/debug blocks
 * (failure transcript tails, cli-assist output); prose renders at
 * the terminal's regular weight.
 */
export function dimWrap(text: string, gutter: number): string {
  return wrapForGutter(text, gutter);
}

/**
 * Wrap clack's `p.note` so card bodies render in the brand body color
 * (#2b6fdc) instead of clack's default dim. Clack runs the formatter
 * on each line individually, so `brandBody` colors each line cleanly
 * without bleeding across the gutter prefix.
 */
export function note(message: string, title?: string): void {
  p.note(message, title, { format: brandBody });
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Truncate a label so the final line — base + reserved suffix — fits in
 * the terminal width. Use on spinner labels that get an elapsed counter
 * appended: if the total exceeds terminal width, clack's cursor-up
 * redraw math breaks and each tick stacks a copy of the line instead
 * of replacing it.
 *
 * `suffix` is the reserved space for what we'll append after `fit()`
 * returns (e.g. ` (999s)` or a tool-use breadcrumb). We don't include
 * it in the output — caller appends it.
 */
export function fitToWidth(base: string, suffix: string): string {
  const cols = process.stdout.columns ?? 80;
  // Overhead we reserve before sizing the label:
  //   spinner icon (1) + 2 padding spaces = 3
  //   clack's animated ellipsis after the label = up to 3 (". " -> "...")
  //   1-char safety margin so wide-char glyphs don't tip over the edge
  // Total reserved budget = 7 cols plus the caller's suffix.
  const budget = Math.max(20, cols - 7 - visibleLength(suffix));
  return base.length > budget ? base.slice(0, budget - 1) + '…' : base;
}

function wrapLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  const words = line.split(' ');
  const rows: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const word of words) {
    const wLen = visibleLength(word);
    if (curLen === 0) {
      cur = word;
      curLen = wLen;
    } else if (curLen + 1 + wLen <= width) {
      cur += ' ' + word;
      curLen += 1 + wLen;
    } else {
      rows.push(cur);
      cur = word;
      curLen = wLen;
    }
  }
  if (cur) rows.push(cur);
  return rows.join('\n');
}
