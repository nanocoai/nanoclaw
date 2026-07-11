/**
 * `/incognito` command parsing for temporal (incognito) sessions.
 *
 * Detected in the router before the command gate and before session
 * resolution, so the command never reaches the container and can redirect
 * routing to a distinct, memory-free temporal session (DMs only).
 */

export type IncognitoKind = 'start' | 'end' | 'none';

export interface IncognitoCommand {
  kind: IncognitoKind;
  /** For `start`, the message text after the command prefix (may be empty). */
  body: string;
}

const START_COMMAND = '/incognito';
const END_ALIASES = new Set(['/exit', '/endincognito']);

/** Extract the `.text` field from a channel message content blob. */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text ?? '').trim();
  } catch {
    return content.trim();
  }
}

/**
 * Classify a message as an incognito command.
 *
 *   `/incognito [message]` → start (message becomes the first turn)
 *   `/incognito end` | `/exit` | `/endincognito` → end
 *   anything else → none
 */
export function parseIncognitoCommand(content: string): IncognitoCommand {
  const text = extractText(content);
  if (!text) return { kind: 'none', body: '' };

  const firstToken = text.split(/\s+/)[0].toLowerCase();

  if (firstToken === START_COMMAND) {
    const rest = text.slice(START_COMMAND.length).trim();
    if (rest.toLowerCase() === 'end') return { kind: 'end', body: '' };
    return { kind: 'start', body: rest };
  }

  if (END_ALIASES.has(firstToken)) return { kind: 'end', body: '' };

  return { kind: 'none', body: text };
}

/**
 * Rewrite a message content blob's `.text` field (used to deliver the
 * prefix-stripped first turn of a `/incognito <message>` command while
 * preserving sender metadata). Falls back to a bare `{ text }` blob if the
 * original content isn't JSON.
 */
export function rewriteContentText(content: string, newText: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, text: newText });
  } catch {
    return JSON.stringify({ text: newText });
  }
}
