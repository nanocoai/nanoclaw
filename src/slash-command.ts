/**
 * Canonical slash-command parse, shared by the host command gate and the
 * runner that executes commands. Both must name a message's command the same
 * way, or the gate can let through a command the runner then executes.
 *
 * Edit `src/slash-command.ts` only, then run `pnpm slash-command:generate`. The runner
 * copy is checked in because the Node host and Bun container are packaged independently
 * and deliberately share no runtime module.
 */

/**
 * The text a command is read from: the trimmed `text` field of JSON content,
 * or the whole trimmed content when it is not JSON.
 */
export function commandText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.trim();
  }
  const text = (parsed as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.trim() : '';
}

// `/name@botname`: Telegram appends the bot's username to commands sent in
// group chats. A token with another `/` or `@` (a path, an npm scope) is left
// whole.
const BOT_SUFFIXED_COMMAND = /^(\/[^\s/@]+)@\w+$/;

/** The first whitespace-delimited token without a `@botname` suffix. */
function commandToken(text: string): string {
  return text.split(/\s/)[0].replace(BOT_SUFFIXED_COMMAND, '$1');
}

/**
 * The command `text` names, or null when it is not a slash command: the first
 * whitespace-delimited token, lowercased, without a `@botname` suffix.
 */
export function slashCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null;
  return commandToken(text).toLowerCase();
}

/**
 * `text` with the `@botname` dropped from its command token (case and
 * arguments kept), so a provider that dispatches the raw text runs the
 * command the gate checked.
 */
export function withoutBotSuffix(text: string): string {
  if (!text.startsWith('/')) return text;
  const token = text.split(/\s/)[0];
  return commandToken(text) + text.slice(token.length);
}
