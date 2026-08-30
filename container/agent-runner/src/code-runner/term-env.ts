/**
 * Terminal-shaped environment the code runner forces into the PTY session
 * (D15/D22). A tiny shared module so the term-audit harness stands up a
 * session with the REAL terminal env (and tests pin it) without executing
 * index.ts's main().
 */
export const SESSION_TERM_ENV: Record<string, string> = {
  TERM: 'xterm-256color',
  // The container has no terminal parent to advertise color depth, and TERM
  // alone caps TUIs at 256 colors (term-audit: env-colorterm). The PTY is a
  // pure byte pipe — truecolor SGR already traverses it byte-exact — so
  // advertising 24-bit support is honest.
  COLORTERM: 'truecolor',
  // The image sets no locale at all, which a raw PTY never noticed: bytes
  // crossed it untouched. tmux PARSES and re-renders the stream, and it
  // decides UTF-8 support from LC_ALL/LC_CTYPE/LANG — with none set it runs
  // non-UTF-8 and renders every multi-byte glyph (the TUI's filled blocks and
  // box drawing) as replacement junk of the wrong width. C.UTF-8 is built
  // into glibc, so this needs no locale package.
  LANG: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
};
