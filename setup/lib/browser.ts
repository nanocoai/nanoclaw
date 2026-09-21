/**
 * Browser-open helpers shared across channel setup flows.
 *
 * `openUrl` is best-effort — silent on failure, so headless/SSH/WSL
 * environments where `open`/`xdg-open` isn't wired up don't crash the
 * setup. The URL should always be visible in the clack note that calls
 * this so the user can copy-paste if the auto-open doesn't land.
 *
 * `confirmThenOpen` pauses for the operator before triggering the open —
 * the browser tends to steal focus when it pops, and a split-second
 * "wait what just happened" moment is worse than letting the user hit
 * Enter when they're ready. On headless devices (no graphical session
 * available) it skips both the prompt and the open: there's no browser
 * to launch, the surrounding `note(...)` already shows the URL for
 * copy-paste on another device, and the next prompt in the channel
 * flow ("Got your bot token?" etc.) provides the natural completion
 * confirmation.
 */
import { spawn } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { isHeadless } from '../platform.js';
import { ensureAnswer } from './runner.js';

/** Best-effort open of a URL in the user's default browser. Silent on failure. */
export function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Headless / no browser / unknown command — URL is printed in the
      // calling note so the user can copy-paste.
    });
    child.unref();
  } catch {
    // swallow — URL is visible in the note.
  }
}

/**
 * Format a URL for inclusion in a setup `note(...)` card. On
 * headless devices we surface the URL inside the card with a
 * "Get started:" label at full strength — copy-pasting onto
 * another device is the actual action, not an incidental
 * reference. The leading `\n` acts as a visual separator from
 * the body steps above; callers `.filter(line => line !== null)`
 * before joining, so on GUI we drop the line entirely (and the
 * URL ends up below the next-step confirm prompt as a "if
 * browser does not appear, please visit" fallback — see
 * `confirmThenOpen`).
 */
export function formatNoteLink(url: string): string | null {
  if (isHeadless()) return `\nGet started: ${url}`;
  return null;
}

/**
 * Gate a browser-open on a confirm so the user is ready for their browser
 * to take focus. Proceeds on cancel as well. On headless devices both the
 * prompt and the open are skipped — the URL is already surfaced inside
 * the surrounding note (via `formatNoteLink`).
 *
 * On GUI devices the confirm message includes the fallback URL on the
 * lines below the action ("If browser does not appear, please visit:
 * <url>" in dim) so the user has a copy-paste path right next to the
 * action button without needing to scroll back up to the card.
 */
export async function confirmThenOpen(url: string, message = 'Press Enter to open your browser'): Promise<void> {
  if (isHeadless()) {
    // No browser to open here — ALWAYS surface the URL itself, and print it
    // RAW on stdout: clack notes wrap long lines and inject gutter pipes and
    // spaces mid-URL, breaking copy-paste (live-hit). Plain stdout is the
    // only rendering that keeps the URL contiguous.
    p.log.info('Open this URL in a browser on any device:');
    process.stdout.write(`\n${url}\n\n`);
    return;
  }
  const fallback = `\n${k.dim(`If browser does not appear, please visit: ${url}`)}`;
  ensureAnswer(
    await p.confirm({
      message: `${message}${fallback}`,
      initialValue: true,
    }),
  );
  openUrl(url);
}
