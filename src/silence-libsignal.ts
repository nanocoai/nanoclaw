/**
 * Silence libsignal's debug console spam.
 *
 * The bundled `libsignal` dep (WhatsApp/Baileys crypto) ships leftover debug
 * logging in `session_record.js` — `console.info("Closing session:", session)`
 * and friends — each of which pretty-prints the entire Signal SessionEntry,
 * including raw key material (rootKey / chainKey / baseKey buffers). On a busy
 * install this was ~54% of the host log volume AND leaked crypto material into
 * a plaintext file.
 *
 * The host's own structured logger (src/log.ts) writes directly to
 * process.stdout / process.stderr and never touches console.*, so filtering
 * console here is safe: it only ever suppresses third-party console output,
 * not our logs. We match on the known first-argument labels so unrelated
 * console output (if any dep ever emits it) still passes through.
 *
 * Imported first in src/index.ts so the patch is installed before any channel
 * adapter (and thus libsignal) can run.
 */
const SILENCED_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Migrating session to:',
  'Session already closed',
  'Session already open',
  'Removing old closed session:',
];

function shouldSilence(args: unknown[]): boolean {
  const first = args[0];
  return typeof first === 'string' && SILENCED_PREFIXES.some((p) => first.startsWith(p));
}

for (const method of ['info', 'warn', 'log'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]): void => {
    if (shouldSilence(args)) return;
    original(...args);
  };
}
