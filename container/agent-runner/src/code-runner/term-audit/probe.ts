/**
 * Terminal audit probe — the disposable child the term-audit harness runs
 * inside the REAL PtySession in place of the interactive agent CLI.
 *
 * Everything it does is evidence for one matrix row:
 *  - boot line: TERM/COLORTERM/geometry as the child actually sees them;
 *  - raw-mode hex echo of every stdin chunk (`[rx <hex>]`) — byte-exact key
 *    passthrough and paste-integrity evidence, reassembled by the harness;
 *  - SIGWINCH trap printing `stty size` (kernel truth) plus process.stdout
 *    geometry — resize-propagation evidence;
 *  - command tokens in the input stream trigger output patterns (truecolor /
 *    256-color SGR, bracketed-paste DECSET toggles, a bulk emit for the
 *    replay-ring row, a geometry report).
 *
 * Guarded with import.meta.main so the harness can import the pattern
 * constants without running the probe.
 */
import fs from 'fs';

export const PROBE_BOOT = 'PROBE_BOOT';
export const PROBE_WINCH = 'PROBE_WINCH';
export const PROBE_SIZE = 'PROBE_SIZE';
export const PROBE_SGR_BEGIN = 'PROBE_SGR_BEGIN';
export const PROBE_SGR_END = 'PROBE_SGR_END';
export const PROBE_BULK_DONE = 'PROBE_BULK_DONE';
export const PROBE_PASTE_ON = 'PROBE_PASTE_ON';
export const PROBE_PASTE_OFF = 'PROBE_PASTE_OFF';

/** Truecolor (24-bit) SGR test pattern — must reach the client byte-exact. */
export const SGR_TRUECOLOR = '\x1b[38;2;10;20;30m\x1b[48;2;200;100;50mTRUECOLOR\x1b[0m';
/** 256-color SGR test pattern — must reach the client byte-exact. */
export const SGR_256 = '\x1b[38;5;196m\x1b[48;5;24mCOLOR256\x1b[0m';
/** DECSET/DECRST 2004 — what a TUI emits to toggle bracketed-paste mode. */
export const PASTE_ON_SEQ = '\x1b[?2004h';
export const PASTE_OFF_SEQ = '\x1b[?2004l';
/** Size of the deterministic bulk emit for the replay-ring row. */
export const BULK_BYTES = 300_000;

/** Command tokens the probe recognizes anywhere in its input stream. */
export const CMD_SGR = '@sgr@';
export const CMD_PASTE_ON = '@paste-on@';
export const CMD_PASTE_OFF = '@paste-off@';
export const CMD_BULK = '@bulk@';
export const CMD_SIZE = '@size@';

export function bulkPattern(bytes: number = BULK_BYTES): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; total < bytes; i++) {
    const line = `bulk-${String(i).padStart(6, '0')} ${'x'.repeat(56)}\n`;
    parts.push(line);
    total += line.length;
  }
  return parts.join('');
}

function main(): void {
  // Mirror every report to a side-channel file when the harness asks
  // (PROBE_LOG): under tmux the client-visible stream is a RENDERING — the
  // redraw may split any text line with cursor motion — so byte-exact rows
  // need an oracle that never rode the screen. The attach-mode matrix leaves
  // this unset and greps the stream exactly as before.
  const logPath = process.env.PROBE_LOG;
  const out = (s: string) => {
    process.stdout.write(s);
    if (logPath) {
      try {
        fs.appendFileSync(logPath, s);
      } catch {
        // the audit's problem, not the probe's
      }
    }
  };
  const cols = () => process.stdout.columns ?? 0;
  const rows = () => process.stdout.rows ?? 0;

  /** The kernel's view of the pty geometry ("rows cols"), read via stdin. */
  function sttySize(): string {
    try {
      const res = Bun.spawnSync(['stty', 'size'], { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
      const text = res.stdout.toString().trim();
      return text || 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  out(
    `${PROBE_BOOT} term=${process.env.TERM ?? 'unset'} colorterm=${process.env.COLORTERM ?? 'unset'} ` +
      `lang=${process.env.LC_CTYPE ?? process.env.LC_ALL ?? process.env.LANG ?? 'unset'} size=${cols()}x${rows()}\n`,
  );

  process.on('SIGWINCH', () => {
    out(`${PROBE_WINCH} stty=[${sttySize()}] size=${cols()}x${rows()}\n`);
  });

  const commands: Array<[string, () => void]> = [
    [CMD_SGR, () => out(`${PROBE_SGR_BEGIN}${SGR_TRUECOLOR}${SGR_256}${PROBE_SGR_END}\n`)],
    [CMD_PASTE_ON, () => out(`${PASTE_ON_SEQ}${PROBE_PASTE_ON}\n`)],
    [CMD_PASTE_OFF, () => out(`${PASTE_OFF_SEQ}${PROBE_PASTE_OFF}\n`)],
    [CMD_BULK, () => out(`${bulkPattern()}${PROBE_BULK_DONE}\n`)],
    // stty is the kernel's live winsize; process.stdout geometry is bun's
    // boot-time snapshot (a term-audit finding: it never refreshes) — report
    // both so the matrix can tell the kernel hop from the notify hop.
    [CMD_SIZE, () => out(`${PROBE_SIZE} stty=[${sttySize()}] size=${cols()}x${rows()}\n`)],
  ];

  // Command tokens may split across input chunks — scan a rolling window.
  let window = '';
  const maxToken = Math.max(...commands.map(([t]) => t.length));

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk: Buffer) => {
    out(`[rx ${chunk.toString('hex')}]\n`);
    window += chunk.toString('latin1');
    for (;;) {
      let earliest: { at: number; token: string; run: () => void } | null = null;
      for (const [token, run] of commands) {
        const at = window.indexOf(token);
        if (at !== -1 && (earliest === null || at < earliest.at)) earliest = { at, token, run };
      }
      if (earliest === null) break;
      earliest.run();
      window = window.slice(earliest.at + earliest.token.length);
    }
    if (window.length > maxToken) window = window.slice(window.length - maxToken);
  });
  process.stdin.resume();
}

if (import.meta.main) main();
