/**
 * Parse a provider auth token out of interactive CLI output captured through
 * a PTY (`script(1)`).
 *
 * Secret this module hides: the menagerie of PTY-capture artifacts that
 * corrupt an otherwise whitespace-free secret. A real terminal wraps long
 * lines, pads with spaces, and interleaves ANSI/control sequences, so a token
 * the CLI printed as one string lands in the capture split across lines with
 * escape codes embedded. Provider login itself succeeds — only our parse of
 * the human-oriented output fails.
 *
 * A normalize step strips the capture artifacts; the extractor matches the
 * token shape against the clean string. A future provider adds its own
 * extractor here rather than regexing raw `script(1)` output.
 *
 * Runnable as a CLI for the bash callers that can't import TS:
 *   tsx setup/lib/captured-token.ts claude <capture-file>
 * Prints the token and exits 0, or exits 1 with nothing on stdout.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

/* eslint-disable no-control-regex -- these patterns exist precisely to match
   the ESC/control bytes a PTY capture is full of. */
// CSI sequences (colors, cursor moves): ESC [ , optional private '?' /
// parameter bytes, optional intermediate bytes, one final byte. Stripped
// explicitly because a colour reset mid-token (sk…\x1b[0m…AA) would otherwise
// leave a `[` that breaks the token's character run.
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Everything <= space (control bytes incl. any stray ESC, CR/LF, tabs, and the
// wrap-padding spaces inserted mid-token) plus DEL. Tokens contain none of these.
const CONTROL_AND_SPACE = /[\x00-\x20\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Collapse PTY-capture artifacts so a whitespace-free secret printed across
 * wrapped lines becomes a single contiguous string. Drops ALL whitespace by
 * design — these captures exist only to recover a token, never prose.
 */
function normalizeCapturedTerminalOutput(raw: string): string {
  return raw.replace(CSI, '').replace(CONTROL_AND_SPACE, '');
}

// Claude subscription OAuth tokens: sk-ant-oat<base64url>AA. Bounded length
// keeps a greedy match from running off the end of the token.
const CLAUDE_OAUTH_TOKEN = /sk-ant-oat[A-Za-z0-9_-]{80,500}AA/g;

/**
 * Extract the Claude OAuth token from a PTY capture of `claude setup-token`,
 * or `null` if none is present. Returns the LAST match — setup-token can echo
 * partial/intermediate output before the final token. Placeholder strings like
 * `<token>` never match (they lack the `sk-ant-oat` prefix).
 */
export function extractClaudeOAuthToken(raw: string): string | null {
  const matches = normalizeCapturedTerminalOutput(raw).match(CLAUDE_OAUTH_TOKEN);
  return matches ? matches[matches.length - 1] : null;
}

function runCli(argv: string[]): number {
  const [provider, file] = argv;
  if (provider !== 'claude' || !file) {
    process.stderr.write('usage: captured-token.ts claude <capture-file>\n');
    return 2;
  }
  const token = extractClaudeOAuthToken(fs.readFileSync(file, 'utf-8'));
  if (!token) return 1;
  process.stdout.write(token);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runCli(process.argv.slice(2)));
}
