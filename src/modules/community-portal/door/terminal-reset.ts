/**
 * What the door writes to a client's terminal when the program on it ended
 * without getting to restore it.
 *
 * A tmux client that detaches cleanly turns off everything it turned on —
 * mouse tracking, focus events, bracketed paste, the alternate screen. One
 * killed under the operator (the container retired or stopped, the exec
 * stream torn down) never sends those disables, and the operator's terminal
 * is left reporting mouse movement and bracketing pastes, with no line
 * saying what happened. The door cannot know which modes were on; the
 * sequences here are the disables, each a no-op on a terminal that never
 * enabled it, followed by a one-line explanation on a fresh line.
 */

/**
 * Disable mouse tracking (X10, button, any-motion, SGR), focus events and
 * bracketed paste; leave the alternate screen; show the cursor; reset
 * attributes. Ordered so the explanation lands on the main screen with a
 * visible cursor and plain attributes.
 */
export const TERMINAL_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse tracking
  '\x1b[?1004l' + // focus events
  '\x1b[?2004l' + // bracketed paste
  '\x1b[?1049l' + // alternate screen
  '\x1b[?25h' + // cursor
  '\x1b[0m'; // attributes

/** The reset, then why the session ended, on its own line — for an end that
 * was not a clean detach; a clean one gets the bare reset and looks like one. */
export function terminalEnded(reason: string): string {
  return `${TERMINAL_RESET}\r\n[nanoclaw] session ended: ${reason}\r\n`;
}
