const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

// WebSocket handshake timeouts from vendored channel adapters (e.g. discord.js's
// `ws` dependency) can emit 'error' on a socket with no listener attached deep
// inside a Node timer callback — Node's EventEmitter contract turns that into a
// synchronous throw with no promise to catch, bypassing the adapter's own
// reconnect/backoff logic entirely. Treat this known, isolated, transient class
// as recoverable instead of taking down the whole host over one dropped socket.
const RECOVERABLE_MESSAGES = ['Opening handshake has timed out'];

function isRecoverable(err: unknown): boolean {
  return err instanceof Error && RECOVERABLE_MESSAGES.includes(err.message);
}

process.on('uncaughtException', (err) => {
  if (isRecoverable(err)) {
    log.warn('Uncaught exception (recoverable, continuing)', { err });
    return;
  }
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
